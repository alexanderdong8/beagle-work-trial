"use strict";

/**
 * Demo reset.
 *
 * Reset removes demo-created shipment/import state so an interviewer can rerun
 * both the shipment and import flows. Raw source fixtures and normalization
 * results are intentionally preserved after startup cleanup.
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

    const importRows = db.prepare("DELETE FROM shipment_import_rows").run();

    const exportShipments = db.prepare("DELETE FROM shipments WHERE source = 'export'").run();
    const importShipments = db.prepare("DELETE FROM shipments WHERE source = 'shipstation_import'").run();

    return {
      deleted_export_shipments: exportShipments.changes,
      deleted_import_shipments: importShipments.changes,
      deleted_import_rows: importRows.changes,
    };
  });

  return tx();
}

module.exports = {
  resetDemoState,
};
