"use strict";

/**
 * ShipStation import orchestration.
 *
 * This service preserves every raw CSV row, auto-matches only high-confidence
 * tenant matches, stores filter-size parse results, and exposes review/flag data
 * for the Import UI.
 */

const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const { repoRoot } = require("../db");
const { addDays, toIsoDate } = require("../utils/dates");
const { parseFilterSizes } = require("./filterSizeService");
const { buildTenantIndexes, findMatch } = require("./importMatchingService");

const SHIPSTATION_FILE = path.join(repoRoot, "shipstation-export.csv");

function getDuplicateTenantIds(db) {
  return new Set(
    db
      .prepare(
        `
          SELECT related_tenant_id
          FROM data_quality_issues
          WHERE issue_type = 'duplicate_tenant_identity'
            AND related_tenant_id IS NOT NULL
        `,
      )
      .pluck()
      .all(),
  );
}

function requiredRowIssue(row) {
  const missing = ["name", "address1", "city", "state", "zip", "shipment_id", "ship_date"].filter(
    (field) => !String(row[field] || "").trim(),
  );
  return missing.length ? `Missing required fields: ${missing.join(", ")}` : null;
}

function createOrUpdateShipment(db, importRow, tenantId) {
  const existing = db.prepare("SELECT * FROM shipments WHERE tracking_number = ?").get(importRow.shipment_id);
  if (existing) {
    db.prepare(
      `
        UPDATE shipments
        SET tenant_id = @tenant_id,
            shipment_date = @shipment_date,
            status = 'shipped'
        WHERE id = @id
      `,
    ).run({
      id: existing.id,
      tenant_id: tenantId,
      shipment_date: importRow.ship_date,
    });
    return existing.id;
  }

  const property = db
    .prepare(
      `
        SELECT property_id, shipment_interval_days
        FROM properties
        WHERE tenant_id = ?
      `,
    )
    .get(tenantId);

  const ordered = db
    .prepare(
      `
        SELECT id
        FROM shipments
        WHERE tenant_id = ?
          AND property_id = ?
          AND status = 'ordered'
        ORDER BY shipment_date DESC, id DESC
        LIMIT 1
      `,
    )
    .get(tenantId, property.property_id);

  if (ordered) {
    db.prepare(
      `
        UPDATE shipments
        SET shipment_date = @shipment_date,
            tracking_number = @tracking_number,
            status = 'shipped'
        WHERE id = @id
      `,
    ).run({
      id: ordered.id,
      shipment_date: importRow.ship_date,
      tracking_number: importRow.shipment_id,
    });
    return ordered.id;
  }

  const info = db
    .prepare(
      `
        INSERT INTO shipments
          (tenant_id, property_id, batch_id, shipment_date, minimum_next_shipment_date,
           tracking_number, status, source)
        VALUES
          (@tenant_id, @property_id, NULL, @shipment_date, @minimum_next_shipment_date,
           @tracking_number, 'shipped', 'shipstation_import')
      `,
    )
    .run({
      tenant_id: tenantId,
      property_id: property.property_id,
      shipment_date: importRow.ship_date,
      minimum_next_shipment_date: addDays(importRow.ship_date, property.shipment_interval_days),
      tracking_number: importRow.shipment_id,
    });

  return info.lastInsertRowid;
}

function insertFilterSizes(db, importRowId, shipmentId, sizeResults) {
  const insert = db.prepare(
    `
      INSERT INTO shipment_filter_sizes
        (shipment_id, import_row_id, raw_value, normalized_value, width_inches,
         height_inches, depth_inches, parse_status, parse_error)
      VALUES
        (@shipment_id, @import_row_id, @raw_value, @normalized_value, @width_inches,
         @height_inches, @depth_inches, @parse_status, @parse_error)
    `,
  );

  for (const size of sizeResults) {
    insert.run({
      shipment_id: shipmentId,
      import_row_id: importRowId,
      raw_value: size.raw_value,
      normalized_value: size.normalized_value,
      width_inches: size.width_inches,
      height_inches: size.height_inches,
      depth_inches: size.depth_inches,
      parse_status: size.parse_status,
      parse_error: size.parse_error,
    });
  }
}

function importShipStationFile(db, filePath = SHIPSTATION_FILE) {
  const rows = parse(fs.readFileSync(filePath, "utf8"), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });
  const tenants = db.prepare("SELECT * FROM tenants ORDER BY id").all();
  const indexes = buildTenantIndexes(tenants, getDuplicateTenantIds(db));

  const tx = db.transaction(() => {
    const batchInfo = db
      .prepare(
        `
          INSERT INTO shipment_import_batches (filename, total_rows)
          VALUES (@filename, @total_rows)
        `,
      )
      .run({
        filename: path.basename(filePath),
        total_rows: rows.length,
      });

    const importBatchId = batchInfo.lastInsertRowid;
    const insertRow = db.prepare(
      `
        INSERT INTO shipment_import_rows
          (import_batch_id, shipment_id, carrier, raw_name, address1, address2,
           city, state, zip, ship_date, custom_field_1, matched_tenant_id,
           matched_shipment_id, match_status, match_score, match_reason,
           matched_fields, conflicting_fields)
        VALUES
          (@import_batch_id, @shipment_id, @carrier, @raw_name, @address1, @address2,
           @city, @state, @zip, @ship_date, @custom_field_1, @matched_tenant_id,
           @matched_shipment_id, @match_status, @match_score, @match_reason,
           @matched_fields, @conflicting_fields)
      `,
    );

    let autoMatchedRows = 0;
    let reviewRows = 0;
    let flaggedRows = 0;
    let sizeWarningRows = 0;

    for (const rawRow of rows) {
      const row = {
        carrier: rawRow.carrier || null,
        custom_field_1: rawRow.custom_field_1 || "",
        ship_date: rawRow.ship_date ? toIsoDate(rawRow.ship_date) : null,
        shipment_id: rawRow.shipment_id || null,
        name: rawRow.name || "",
        address1: rawRow.address1 || null,
        address2: rawRow.address2 || null,
        city: rawRow.city || null,
        state: rawRow.state || null,
        zip: rawRow.zip || null,
      };
      const requiredIssue = requiredRowIssue(rawRow);
      const sizeResults = parseFilterSizes(row.custom_field_1);
      const hasSizeWarning = sizeResults.some((size) => size.parse_status !== "parsed");

      let match = requiredIssue
        ? {
            matchedTenant: null,
            matchStatus: "needs_review",
            matchScore: 0,
            matchReason: "missing_required_fields",
            matchedFields: [],
            conflictingFields: [],
          }
        : findMatch(row, indexes);

      let shipmentId = null;
      if (match.matchedTenant) {
        shipmentId = createOrUpdateShipment(db, row, match.matchedTenant.id);
        autoMatchedRows += 1;
      } else {
        reviewRows += 1;
      }

      if (match.matchStatus === "needs_review" || hasSizeWarning) flaggedRows += 1;
      if (hasSizeWarning) sizeWarningRows += 1;

      const rowInfo = insertRow.run({
        import_batch_id: importBatchId,
        shipment_id: row.shipment_id,
        carrier: row.carrier,
        raw_name: row.name,
        address1: row.address1,
        address2: row.address2,
        city: row.city,
        state: row.state,
        zip: row.zip,
        ship_date: row.ship_date,
        custom_field_1: row.custom_field_1,
        matched_tenant_id: match.matchedTenant ? match.matchedTenant.id : null,
        matched_shipment_id: shipmentId,
        match_status: match.matchStatus,
        match_score: match.matchScore,
        match_reason: requiredIssue || match.matchReason,
        matched_fields: JSON.stringify(match.matchedFields),
        conflicting_fields: JSON.stringify(match.conflictingFields),
      });

      insertFilterSizes(db, rowInfo.lastInsertRowid, shipmentId, sizeResults);
    }

    db.prepare(
      `
        UPDATE shipment_import_batches
        SET auto_matched_rows = @auto_matched_rows,
            review_rows = @review_rows,
            flagged_rows = @flagged_rows,
            size_warning_rows = @size_warning_rows
        WHERE id = @id
      `,
    ).run({
      id: importBatchId,
      auto_matched_rows: autoMatchedRows,
      review_rows: reviewRows,
      flagged_rows: flaggedRows,
      size_warning_rows: sizeWarningRows,
    });

    return importBatchId;
  });

  return getImportBatchDetail(db, tx());
}

function parseJsonArray(value) {
  try {
    return JSON.parse(value || "[]");
  } catch {
    return [];
  }
}

function getImportBatchDetail(db, batchId) {
  const batch = db.prepare("SELECT * FROM shipment_import_batches WHERE id = ?").get(batchId);
  if (!batch) return null;

  const rows = db
    .prepare(
      `
        SELECT ir.*, t.first_name, t.last_name, t.address1 AS tenant_address1,
               t.address2 AS tenant_address2, t.city AS tenant_city,
               t.state AS tenant_state, t.zip AS tenant_zip,
               s.status AS shipment_status
        FROM shipment_import_rows ir
        LEFT JOIN tenants t ON t.id = ir.matched_tenant_id
        LEFT JOIN shipments s ON s.id = ir.matched_shipment_id
        WHERE ir.import_batch_id = ?
        ORDER BY ir.id
      `,
    )
    .all(batchId);

  const sizeRows = db
    .prepare(
      `
        SELECT *
        FROM shipment_filter_sizes
        WHERE import_row_id IN (
          SELECT id FROM shipment_import_rows WHERE import_batch_id = ?
        )
        ORDER BY id
      `,
    )
    .all(batchId);
  const sizesByRow = new Map();
  for (const size of sizeRows) {
    if (!sizesByRow.has(size.import_row_id)) sizesByRow.set(size.import_row_id, []);
    sizesByRow.get(size.import_row_id).push(size);
  }

  const decoratedRows = rows.map((row) => ({
    ...row,
    matched_fields: parseJsonArray(row.matched_fields),
    conflicting_fields: parseJsonArray(row.conflicting_fields),
    filter_sizes: sizesByRow.get(row.id) || [],
  }));

  return {
    batch,
    matchedRows: decoratedRows.filter((row) => ["auto_matched", "manually_matched"].includes(row.match_status)),
    reviewRows: decoratedRows.filter((row) => row.match_status === "needs_review"),
    flags: buildFlags(decoratedRows),
  };
}

function latestImportBatch(db) {
  const batch = db
    .prepare("SELECT id FROM shipment_import_batches ORDER BY imported_at DESC, id DESC LIMIT 1")
    .get();
  return batch ? getImportBatchDetail(db, batch.id) : null;
}

function buildFlags(rows) {
  const flags = [];
  for (const row of rows) {
    if (row.match_status === "needs_review") {
      flags.push({
        import_row_id: row.id,
        shipment_id: row.shipment_id,
        raw_recipient: row.raw_name,
        issue_type: row.match_reason,
        raw_value: `${row.address1 || ""} ${row.address2 || ""}, ${row.city || ""}, ${row.state || ""} ${row.zip || ""}`.trim(),
        explanation: row.match_reason,
        follow_up: "Review candidate tenants and confirm or dismiss this row.",
      });
    }

    for (const size of row.filter_sizes) {
      if (size.parse_status === "parsed") continue;
      flags.push({
        import_row_id: row.id,
        shipment_id: row.shipment_id,
        raw_recipient: row.raw_name,
        issue_type: "filter_size_needs_review",
        raw_value: size.raw_value,
        explanation: size.parse_error,
        follow_up: followUpForSizeError(size.parse_error),
      });
    }
  }
  return flags;
}

function followUpForSizeError(error) {
  if (error === "No filter size provided") {
    return "Contact tenant/property manager or check prior shipment/order notes to determine what filter size should have shipped.";
  }
  if (error === "Unsupported word-based dimension") {
    return "Human needs to interpret the semantic text size before it can be used.";
  }
  if (error === "Dimension appears to contain a range or ambiguous hyphen") {
    return "Review original ShipStation order or contact fulfillment partner because the size is ambiguous.";
  }
  if (error === "Missing required dimension") {
    return "Missing width/height/depth information; check the source order.";
  }
  return "Review the raw size value and correct it if needed.";
}

function getCandidatesForImportRow(db, importRowId) {
  const row = db.prepare("SELECT * FROM shipment_import_rows WHERE id = ?").get(importRowId);
  if (!row) return null;
  const tenants = db.prepare("SELECT * FROM tenants ORDER BY id").all();
  const indexes = buildTenantIndexes(tenants, getDuplicateTenantIds(db));
  const match = findMatch(
    {
      name: row.raw_name,
      address1: row.address1,
      address2: row.address2,
      city: row.city,
      state: row.state,
      zip: row.zip,
    },
    indexes,
  );
  return { row, candidates: match.candidates };
}

function confirmImportRow(db, importRowId, tenantId) {
  const row = db.prepare("SELECT * FROM shipment_import_rows WHERE id = ?").get(importRowId);
  if (!row) return null;
  const shipmentId = createOrUpdateShipment(
    db,
    {
      shipment_id: row.shipment_id,
      ship_date: row.ship_date,
    },
    tenantId,
  );

  db.prepare(
    `
      UPDATE shipment_import_rows
      SET matched_tenant_id = @tenant_id,
          matched_shipment_id = @shipment_id,
          match_status = 'manually_matched',
          reviewed_at = CURRENT_TIMESTAMP
      WHERE id = @id
    `,
  ).run({ id: importRowId, tenant_id: tenantId, shipment_id: shipmentId });
  db.prepare("UPDATE shipment_filter_sizes SET shipment_id = ? WHERE import_row_id = ?").run(shipmentId, importRowId);
  return db.prepare("SELECT * FROM shipment_import_rows WHERE id = ?").get(importRowId);
}

function dismissImportRow(db, importRowId) {
  db.prepare(
    `
      UPDATE shipment_import_rows
      SET match_status = 'dismissed',
          reviewed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
  ).run(importRowId);
  return db.prepare("SELECT * FROM shipment_import_rows WHERE id = ?").get(importRowId);
}

module.exports = {
  confirmImportRow,
  dismissImportRow,
  getCandidatesForImportRow,
  getImportBatchDetail,
  importShipStationFile,
  latestImportBatch,
};
