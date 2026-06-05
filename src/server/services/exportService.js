"use strict";

/**
 * Shipment export service.
 *
 * Exporting is a write operation: it persists ordered shipments and returns a
 * CSV for those same rows. There is no separate batch table in this simplified
 * schema; the shipment rows themselves are the operational record.
 */

const { addDays } = require("../utils/dates");
const { csvEscape } = require("../utils/strings");
const { getEligibility } = require("./eligibilityService");

const CSV_COLUMNS = [
  "tenant_id",
  "property_id",
  "first_name",
  "last_name",
  "address1",
  "address2",
  "city",
  "state",
  "zip",
  "shipment_date",
  "minimum_next_shipment_date",
];

function toCsv(rows) {
  // Keep CSV generation deliberately small and explicit. The selected columns
  // are shipping/audit fields only, not internal eligibility evidence.
  const lines = [CSV_COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(CSV_COLUMNS.map((column) => csvEscape(row[column])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function createExportBatch(db, options = {}) {
  const eligibility = getEligibility(db, options);
  const asOf = eligibility.asOf;
  const selected = eligibility.eligible;
  const exportedAt = new Date().toISOString();

  const tx = db.transaction(() => {
    // Ordered rows immediately count for cooldown, preventing duplicate exports
    // before the shipping partner returns tracking information.
    const insertShipment = db.prepare(
      `
        INSERT INTO shipments
          (tenant_id, property_id, shipment_date, minimum_next_shipment_date,
           tracking_number, status, source)
        VALUES
          (@tenant_id, @property_id, @shipment_date, @minimum_next_shipment_date,
           NULL, 'ordered', 'export')
      `,
    );

    const rows = [];
    for (const row of selected) {
      insertShipment.run({
        tenant_id: row.tenant_id,
        property_id: row.property_id,
        shipment_date: asOf,
        minimum_next_shipment_date: addDays(asOf, row.shipment_interval_days),
      });
      rows.push({
        tenant_id: row.tenant_id,
        property_id: row.property_id,
        first_name: row.first_name,
        last_name: row.last_name,
        address1: row.address1,
        address2: row.address2,
        city: row.city,
        state: row.state,
        zip: row.zip,
        shipment_date: asOf,
        minimum_next_shipment_date: addDays(asOf, row.shipment_interval_days),
      });
    }

    return rows;
  });

  const rows = tx();
  const exportRecord = {
    as_of_date: asOf,
    exported_at: exportedAt,
    shipment_count: rows.length,
    csv_filename: `shipments-${asOf}.csv`,
  };

  return {
    batch: exportRecord,
    export: exportRecord,
    csv: toCsv(rows),
    rows,
  };
}

module.exports = {
  CSV_COLUMNS,
  createExportBatch,
  toCsv,
};
