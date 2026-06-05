"use strict";

/**
 * Demo reset.
 *
 * Reset only removes export-created state so an interviewer can rerun the
 * shipment flow. Raw fixtures, historical shipments, and normalization results
 * are intentionally preserved.
 */

function resetDemoState(db) {
  const tx = db.transaction(() => {
    db.prepare(
      `
        UPDATE shipments
        SET status = 'historical'
        WHERE source = 'historical'
          AND id IN (
            SELECT matched_shipment_id
            FROM shipment_import_rows
            WHERE matched_shipment_id IS NOT NULL
          )
      `,
    ).run();

    const filterSizes = db.prepare("DELETE FROM shipment_filter_sizes").run();
    const importRows = db.prepare("DELETE FROM shipment_import_rows").run();
    const importBatches = db.prepare("DELETE FROM shipment_import_batches").run();

    const exportShipments = db.prepare("DELETE FROM shipments WHERE source = 'export'").run();
    const importShipments = db.prepare("DELETE FROM shipments WHERE source = 'shipstation_import'").run();

    const batches = db.prepare("DELETE FROM shipment_batches").run();

    return {
      deleted_export_shipments: exportShipments.changes,
      deleted_import_shipments: importShipments.changes,
      deleted_batches: batches.changes,
      deleted_import_batches: importBatches.changes,
      deleted_import_rows: importRows.changes,
      deleted_filter_sizes: filterSizes.changes,
    };
  });

  return tx();
}

module.exports = {
  resetDemoState,
};
