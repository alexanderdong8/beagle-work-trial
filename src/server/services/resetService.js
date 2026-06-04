"use strict";

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
