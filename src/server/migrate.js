"use strict";

const { openDb } = require("./db");
const { addDays } = require("./utils/dates");
const { tenantFullName } = require("./utils/strings");
const {
  loadRawProperties,
  normalizeProperties,
  writeNormalizedPropertiesFile,
} = require("./services/normalizeProperties");

const DEFAULT_AS_OF_DATE = "2026-04-24";

function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS properties (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      shipment_interval_days INTEGER NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tenant_properties (
      tenant_id INTEGER PRIMARY KEY REFERENCES tenants(id),
      property_id TEXT NOT NULL REFERENCES properties(id),
      assignment_source TEXT NOT NULL,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS data_quality_issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_type TEXT NOT NULL,
      tenant_id INTEGER,
      related_tenant_id INTEGER,
      property_id TEXT,
      related_property_id TEXT,
      details TEXT NOT NULL,
      resolution TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS shipment_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      as_of_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'exported',
      exported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      shipment_count INTEGER NOT NULL DEFAULT 0,
      csv_filename TEXT,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS shipments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      property_id TEXT NOT NULL REFERENCES properties(id),
      batch_id INTEGER REFERENCES shipment_batches(id),
      shipment_date TEXT NOT NULL,
      minimum_next_shipment_date TEXT NOT NULL,
      tracking_number TEXT UNIQUE,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_tenant_properties_property_id
      ON tenant_properties(property_id);
    CREATE INDEX IF NOT EXISTS idx_shipments_property_date
      ON shipments(property_id, shipment_date);
    CREATE INDEX IF NOT EXISTS idx_shipments_status
      ON shipments(status);
    CREATE INDEX IF NOT EXISTS idx_shipments_batch_id
      ON shipments(batch_id);
  `);
}

function seedOperationalData(db) {
  const tenants = db.prepare("SELECT * FROM tenants ORDER BY id").all();
  const normalized = normalizeProperties(loadRawProperties(), tenants);
  writeNormalizedPropertiesFile(normalized);

  const tx = db.transaction(() => {
    db.prepare("DELETE FROM data_quality_issues").run();
    db.prepare("DELETE FROM tenant_properties").run();

    const insertProperty = db.prepare(`
      INSERT INTO properties (id, name, shipment_interval_days, source)
      VALUES (@id, @name, @shipment_interval_days, @source)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        shipment_interval_days = excluded.shipment_interval_days,
        source = excluded.source
    `);

    const insertAssignment = db.prepare(`
      INSERT INTO tenant_properties (tenant_id, property_id, assignment_source, notes)
      VALUES (@tenant_id, @property_id, @assignment_source, @notes)
    `);

    const insertIssue = db.prepare(`
      INSERT INTO data_quality_issues
        (issue_type, tenant_id, related_tenant_id, property_id, related_property_id, details, resolution)
      VALUES
        (@issue_type, @tenant_id, @related_tenant_id, @property_id, @related_property_id, @details, @resolution)
    `);

    for (const property of normalized.normalizedProperties) {
      insertProperty.run({
        id: property.id,
        name: property.name,
        shipment_interval_days: property.shipment_interval_days,
        source: property.source,
      });
    }

    for (const assignment of normalized.tenantProperties) {
      insertAssignment.run(assignment);
    }

    for (const issue of normalized.dataQualityIssues) {
      insertIssue.run({
        issue_type: issue.issue_type,
        tenant_id: issue.tenant_id || null,
        related_tenant_id: issue.related_tenant_id || null,
        property_id: issue.property_id || null,
        related_property_id: issue.related_property_id || null,
        details: issue.details,
        resolution: issue.resolution,
      });
    }
  });

  tx();
}

function recordHistoricalIssues(db) {
  const insertIssue = db.prepare(`
    INSERT INTO data_quality_issues
      (issue_type, tenant_id, property_id, details, resolution)
    VALUES
      (@issue_type, @tenant_id, @property_id, @details, @resolution)
  `);

  const tenantProperty = db
    .prepare("SELECT property_id FROM tenant_properties WHERE tenant_id = ?")
    .pluck();

  const futureShipments = db
    .prepare(`
      SELECT id, tenant_id, ship_date, tracking_number
      FROM historical_shipments
      WHERE ship_date > ?
      ORDER BY ship_date
    `)
    .all(DEFAULT_AS_OF_DATE);

  for (const shipment of futureShipments) {
    insertIssue.run({
      issue_type: "future_dated_historical_shipment",
      tenant_id: shipment.tenant_id,
      property_id: tenantProperty.get(shipment.tenant_id) || null,
      details: `Historical shipment ${shipment.tracking_number} is dated ${shipment.ship_date}, after default eligibility date ${DEFAULT_AS_OF_DATE}.`,
      resolution: "Eligibility queries filter shipments to shipment_date <= selected asOf date, so future rows do not affect earlier calculations.",
    });
  }

  const addressMismatches = db
    .prepare(`
      SELECT hs.id, hs.tenant_id, hs.tracking_number, hs.address1 AS historical_address1,
             hs.address2 AS historical_address2, hs.city AS historical_city,
             hs.state AS historical_state, hs.zip AS historical_zip,
             t.first_name, t.last_name, t.address1, t.address2, t.city, t.state, t.zip
      FROM historical_shipments hs
      JOIN tenants t ON t.id = hs.tenant_id
      WHERE lower(hs.address1) <> lower(t.address1)
         OR coalesce(lower(hs.address2), '') <> coalesce(lower(t.address2), '')
         OR lower(hs.city) <> lower(t.city)
         OR lower(hs.state) <> lower(t.state)
         OR lower(hs.zip) <> lower(t.zip)
      ORDER BY hs.id
    `)
    .all();

  for (const row of addressMismatches) {
    insertIssue.run({
      issue_type: "historical_address_mismatch",
      tenant_id: row.tenant_id,
      property_id: tenantProperty.get(row.tenant_id) || null,
      details: `Historical shipment ${row.tracking_number} for ${tenantFullName(row)} used ${row.historical_address1}, ${row.historical_city}, ${row.historical_state} ${row.historical_zip}; current tenant address is ${row.address1}, ${row.city}, ${row.state} ${row.zip}.`,
      resolution: "Preserved historical recipient address for audit, but future exports use the current tenant address.",
    });
  }
}

function normalizeHistoricalShipments(db) {
  const rows = db
    .prepare(`
      SELECT hs.*, tp.property_id, p.shipment_interval_days
      FROM historical_shipments hs
      JOIN tenant_properties tp ON tp.tenant_id = hs.tenant_id
      JOIN properties p ON p.id = tp.property_id
      ORDER BY hs.id
    `)
    .all();

  const insert = db.prepare(`
    INSERT OR IGNORE INTO shipments
      (tenant_id, property_id, batch_id, shipment_date, minimum_next_shipment_date,
       tracking_number, status, source)
    VALUES
      (@tenant_id, @property_id, NULL, @shipment_date, @minimum_next_shipment_date,
       @tracking_number, 'historical', 'historical')
  `);

  const tx = db.transaction(() => {
    for (const row of rows) {
      insert.run({
        tenant_id: row.tenant_id,
        property_id: row.property_id,
        shipment_date: row.ship_date,
        minimum_next_shipment_date: addDays(row.ship_date, row.shipment_interval_days),
        tracking_number: row.tracking_number,
      });
    }
  });

  tx();
}

function migrate() {
  const db = openDb();
  try {
    createSchema(db);
    seedOperationalData(db);
    recordHistoricalIssues(db);
    normalizeHistoricalShipments(db);
  } finally {
    db.close();
  }
}

if (require.main === module) {
  migrate();
  console.log("Migration complete.");
}

module.exports = {
  createSchema,
  migrate,
  normalizeHistoricalShipments,
  recordHistoricalIssues,
  seedOperationalData,
};
