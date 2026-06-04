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
    const exportShipments = db
      .prepare("DELETE FROM shipments WHERE source = 'export'")
      .run();

    const batches = db.prepare("DELETE FROM shipment_batches").run();

    return {
      deleted_export_shipments: exportShipments.changes,
      deleted_batches: batches.changes,
    };
  });

  return tx();
}

module.exports = {
  resetDemoState,
};
