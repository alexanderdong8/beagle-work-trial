"use strict";

const { addDays } = require("../utils/dates");
const { csvEscape } = require("../utils/strings");
const { getEligibility } = require("./eligibilityService");

const CSV_COLUMNS = [
  "tenant_id",
  "property_id",
  "batch_id",
  "recipient_name",
  "address1",
  "address2",
  "city",
  "state",
  "zip",
  "shipment_date",
  "minimum_next_shipment_date",
];

function toCsv(rows) {
  const lines = [CSV_COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(CSV_COLUMNS.map((column) => csvEscape(row[column])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function getBatchRows(db, batchId) {
  return db
    .prepare(
      `
        SELECT
          s.tenant_id,
          s.property_id,
          s.batch_id,
          t.first_name || ' ' || t.last_name AS recipient_name,
          t.address1,
          t.address2,
          t.city,
          t.state,
          t.zip,
          s.shipment_date,
          s.minimum_next_shipment_date
        FROM shipments s
        JOIN tenants t ON t.id = s.tenant_id
        WHERE s.batch_id = ?
        ORDER BY s.id ASC
      `,
    )
    .all(batchId);
}

function createExportBatch(db, options = {}) {
  const eligibility = getEligibility(db, options);
  const asOf = eligibility.asOf;
  const selected = eligibility.eligible;

  const tx = db.transaction(() => {
    const batchInfo = db
      .prepare(
        `
          INSERT INTO shipment_batches (as_of_date, status, shipment_count, csv_filename, notes)
          VALUES (@as_of_date, 'exported', @shipment_count, @csv_filename, @notes)
        `,
      )
      .run({
        as_of_date: asOf,
        shipment_count: selected.length,
        csv_filename: null,
        notes: "Generated from eligibility export.",
      });

    const batchId = batchInfo.lastInsertRowid;
    const csvFilename = `shipment-batch-${batchId}.csv`;

    db.prepare("UPDATE shipment_batches SET csv_filename = ? WHERE id = ?").run(csvFilename, batchId);

    const insertShipment = db.prepare(
      `
        INSERT INTO shipments
          (tenant_id, property_id, batch_id, shipment_date, minimum_next_shipment_date,
           tracking_number, status, source)
        VALUES
          (@tenant_id, @property_id, @batch_id, @shipment_date, @minimum_next_shipment_date,
           NULL, 'ordered', 'export')
      `,
    );

    for (const row of selected) {
      insertShipment.run({
        tenant_id: row.tenant_id,
        property_id: row.property_id,
        batch_id: batchId,
        shipment_date: asOf,
        minimum_next_shipment_date: addDays(asOf, row.shipment_interval_days),
      });
    }

    return batchId;
  });

  const batchId = tx();
  const rows = getBatchRows(db, batchId);

  return {
    batch: getBatch(db, batchId),
    csv: toCsv(rows),
    rows,
  };
}

function getBatch(db, batchId) {
  return db.prepare("SELECT * FROM shipment_batches WHERE id = ?").get(batchId);
}

function listBatches(db) {
  return db
    .prepare(
      `
        SELECT b.*, COUNT(s.id) AS persisted_shipment_count
        FROM shipment_batches b
        LEFT JOIN shipments s ON s.batch_id = b.id
        GROUP BY b.id
        ORDER BY b.exported_at DESC, b.id DESC
      `,
    )
    .all();
}

function getBatchCsv(db, batchId) {
  const batch = getBatch(db, batchId);
  if (!batch) return null;

  return {
    batch,
    csv: toCsv(getBatchRows(db, batchId)),
  };
}

module.exports = {
  CSV_COLUMNS,
  createExportBatch,
  getBatchCsv,
  listBatches,
  toCsv,
};
