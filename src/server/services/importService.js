"use strict";

/**
 * ShipStation import orchestration.
 *
 * The simplified schema stores one row per imported CSV line in
 * shipment_import_rows. Filter sizes are normalized into JSON on that same row
 * instead of being split into a separate table.
 */

const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const { repoRoot } = require("../db");
const { addDays, toIsoDate } = require("../utils/dates");
const { parseFilterSizes } = require("./filterSizeService");
const { buildTenantIndexes, findMatch } = require("./importMatchingService");

const SHIPSTATION_FILE = path.join(repoRoot, "shipstation-export.csv");

function requiredRowIssue(row) {
  // Required fields mirror the minimum data needed to create or reconcile a
  // shipment record safely.
  const missing = ["name", "address1", "city", "state", "zip", "shipment_id", "ship_date"].filter(
    (field) => !String(row[field] || "").trim(),
  );
  return missing.length ? `Missing required fields: ${missing.join(", ")}` : null;
}

function createOrUpdateShipment(db, importRow, tenantId) {
  // First priority: if this tracking number already exists, treat this as a
  // reconciliation update rather than a new shipment insert.
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
    // Common case: export created an "ordered" row earlier; import upgrades it
    // to "shipped" once ShipStation confirms tracking.
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

  // Fallback: shipment did not originate from our export table, so insert a new
  // shipped row sourced from ShipStation.
  const info = db
    .prepare(
      `
        INSERT INTO shipments
          (tenant_id, property_id, shipment_date, minimum_next_shipment_date,
           tracking_number, status, source)
        VALUES
          (@tenant_id, @property_id, @shipment_date, @minimum_next_shipment_date,
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

function importShipStationFile(db, options = {}) {
  const filePath = typeof options === "string" ? options : options.filePath || SHIPSTATION_FILE;
  const csvText = typeof options === "object" && options.csvText
    ? options.csvText
    : fs.readFileSync(filePath, "utf8");
  const filename = typeof options === "object" && options.filename
    ? path.basename(options.filename)
    : path.basename(filePath);

  const rows = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });
  const tenants = db.prepare("SELECT * FROM tenants ORDER BY id").all();
  const indexes = buildTenantIndexes(tenants);
  const importedAt = new Date().toISOString();

  const tx = db.transaction(() => {
    // This app keeps one active import snapshot for review; re-import replaces
    // prior rows so the UI always reflects the latest uploaded file.
    db.prepare("DELETE FROM shipment_import_rows").run();

    const insertRow = db.prepare(
      `
        INSERT INTO shipment_import_rows
          (filename, imported_at, shipment_id, carrier, raw_name, address1, address2,
           city, state, zip, ship_date, custom_field_1, matched_tenant_id,
           matched_shipment_id, match_status, match_score, match_reason,
           matched_fields, conflicting_fields, filter_sizes)
        VALUES
          (@filename, @imported_at, @shipment_id, @carrier, @raw_name, @address1, @address2,
           @city, @state, @zip, @ship_date, @custom_field_1, @matched_tenant_id,
           @matched_shipment_id, @match_status, @match_score, @match_reason,
           @matched_fields, @conflicting_fields, @filter_sizes)
      `,
    );

    for (const rawRow of rows) {
      // Normalize input into a predictable shape before validation/matching.
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

      // Required-field failures never auto-match, but still persist for review.
      const match = requiredIssue
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
      }

      insertRow.run({
        filename,
        imported_at: importedAt,
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
        filter_sizes: JSON.stringify(sizeResults),
      });
    }
  });

  tx();
  return latestImportBatch(db);
}

function parseJsonArray(value) {
  try {
    return JSON.parse(value || "[]");
  } catch {
    return [];
  }
}

function decorateRows(rows) {
  // Parse JSON payload columns into arrays so API callers receive ready-to-use
  // objects instead of JSON strings.
  return rows.map((row) => ({
    ...row,
    matched_fields: parseJsonArray(row.matched_fields),
    conflicting_fields: parseJsonArray(row.conflicting_fields),
    filter_sizes: parseJsonArray(row.filter_sizes),
  }));
}

function getCurrentImportRows(db) {
  return db
    .prepare(
      `
        SELECT ir.*, t.first_name, t.last_name, t.address1 AS tenant_address1,
               t.address2 AS tenant_address2, t.city AS tenant_city,
               t.state AS tenant_state, t.zip AS tenant_zip,
               s.status AS shipment_status
        FROM shipment_import_rows ir
        LEFT JOIN tenants t ON t.id = ir.matched_tenant_id
        LEFT JOIN shipments s ON s.id = ir.matched_shipment_id
        ORDER BY ir.id
      `,
    )
    .all();
}

function latestImportBatch(db) {
  const rows = decorateRows(getCurrentImportRows(db));
  if (!rows.length) return null;

  // Batch metadata is derived from the row snapshot (no separate batch table).
  const batch = {
    filename: rows[0].filename,
    imported_at: rows[0].imported_at,
    total_rows: rows.length,
    auto_matched_rows: rows.filter((row) => row.match_status === "auto_matched").length,
    review_rows: rows.filter((row) => row.match_status === "needs_review").length,
    flagged_rows: buildFlags(rows).length,
    dismissed_rows: rows.filter((row) => row.match_status === "dismissed").length,
  };

  return {
    batch,
    matchedRows: rows.filter((row) => ["auto_matched", "manually_matched"].includes(row.match_status)),
    reviewRows: rows.filter((row) => row.match_status === "needs_review"),
    flags: buildFlags(rows),
  };
}

function buildFlags(rows) {
  const flags = [];
  for (const row of rows) {
    if (row.match_status === "needs_review") {
      // Matching ambiguity or missing required data becomes a review flag.
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
      // Keep size parsing issues visible alongside match-review issues.
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
  const indexes = buildTenantIndexes(tenants);
  // Re-run matching logic for this row and return scored candidates for manual
  // reviewer confirmation.
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
  // Manual confirmation reuses the same shipment reconciliation logic as auto
  // matching so status transitions stay consistent.
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
  return db.prepare("SELECT * FROM shipment_import_rows WHERE id = ?").get(importRowId);
}

function dismissImportRow(db, importRowId) {
  // Dismiss keeps the raw row for audit/history but marks it complete for the
  // current review queue.
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
  importShipStationFile,
  latestImportBatch,
};
