"use strict";

/**
 * Migration/normalization entrypoint.
 *
 * The migration creates operational tables around the provided raw fixtures,
 * generates normalized property assignments, records data-quality findings, and
 * copies historical shipments into the unified shipments table.
 */

const { openDb } = require("./db");
const { addDays } = require("./utils/dates");
const { tenantFullName } = require("./utils/strings");
const { normalizedRiderLabels } = require("./services/normalizeRiders");
const {
  loadRawProperties,
  normalizeProperties,
  writeNormalizedPropertiesFile,
} = require("./services/normalizeProperties");

const DEFAULT_AS_OF_DATE = "2026-04-24";

function createSchema(db) {
  // Tables are created idempotently so the app can run migration on startup.
  db.exec(`
    CREATE TABLE IF NOT EXISTS properties (
      tenant_id INTEGER PRIMARY KEY REFERENCES tenants(id),
      property_id TEXT NOT NULL,
      name TEXT NOT NULL,
      shipment_interval_days INTEGER NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
      property_id TEXT NOT NULL,
      batch_id INTEGER REFERENCES shipment_batches(id),
      shipment_date TEXT NOT NULL,
      minimum_next_shipment_date TEXT NOT NULL,
      tracking_number TEXT UNIQUE,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS shipment_import_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      total_rows INTEGER NOT NULL DEFAULT 0,
      auto_matched_rows INTEGER NOT NULL DEFAULT 0,
      review_rows INTEGER NOT NULL DEFAULT 0,
      flagged_rows INTEGER NOT NULL DEFAULT 0,
      size_warning_rows INTEGER NOT NULL DEFAULT 0,
      dismissed_rows INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'imported'
    );

    CREATE TABLE IF NOT EXISTS shipment_import_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_batch_id INTEGER NOT NULL REFERENCES shipment_import_batches(id),
      shipment_id TEXT,
      carrier TEXT,
      raw_name TEXT NOT NULL,
      address1 TEXT,
      address2 TEXT,
      city TEXT,
      state TEXT,
      zip TEXT,
      ship_date TEXT,
      custom_field_1 TEXT,
      matched_tenant_id INTEGER REFERENCES tenants(id),
      matched_shipment_id INTEGER REFERENCES shipments(id),
      match_status TEXT NOT NULL,
      match_score INTEGER NOT NULL DEFAULT 0,
      match_reason TEXT,
      matched_fields TEXT,
      conflicting_fields TEXT,
      reviewed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS shipment_filter_sizes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shipment_id INTEGER REFERENCES shipments(id),
      import_row_id INTEGER NOT NULL REFERENCES shipment_import_rows(id),
      raw_value TEXT NOT NULL,
      normalized_value TEXT,
      width_inches REAL,
      height_inches REAL,
      depth_inches REAL,
      parse_status TEXT NOT NULL,
      parse_error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_shipments_property_date
      ON shipments(property_id, shipment_date);
    CREATE INDEX IF NOT EXISTS idx_shipments_status
      ON shipments(status);
    CREATE INDEX IF NOT EXISTS idx_shipments_batch_id
      ON shipments(batch_id);
    CREATE INDEX IF NOT EXISTS idx_import_rows_batch_status
      ON shipment_import_rows(import_batch_id, match_status);
    CREATE INDEX IF NOT EXISTS idx_import_rows_tenant
      ON shipment_import_rows(matched_tenant_id);
    CREATE INDEX IF NOT EXISTS idx_filter_sizes_import_row
      ON shipment_filter_sizes(import_row_id);
  `);

  const enrollmentColumns = new Set(
    db
      .prepare("PRAGMA table_info(enrollments)")
      .all()
      .map((column) => column.name),
  );

  if (!enrollmentColumns.has("normalized_rider_labels")) {
    db.prepare("ALTER TABLE enrollments ADD COLUMN normalized_rider_labels TEXT").run();
  }

  const propertyColumns = new Set(
    db
      .prepare("PRAGMA table_info(properties)")
      .all()
      .map((column) => column.name),
  );

  if (
    !propertyColumns.has("tenant_id") ||
    propertyColumns.has("id") ||
    propertyColumns.has("source") ||
    propertyColumns.has("assignment_source")
  ) {
    db.pragma("foreign_keys = OFF");
    try {
      db.exec(`
        DROP INDEX IF EXISTS idx_tenant_properties_property_id;
        DROP INDEX IF EXISTS idx_properties_property_id;
        DROP TABLE IF EXISTS tenant_properties;
        DROP TABLE IF EXISTS properties;
        CREATE TABLE properties (
          tenant_id INTEGER PRIMARY KEY REFERENCES tenants(id),
          property_id TEXT NOT NULL,
          name TEXT NOT NULL,
          shipment_interval_days INTEGER NOT NULL,
          notes TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX idx_properties_property_id
          ON properties(property_id);
      `);
    } finally {
      db.pragma("foreign_keys = ON");
    }
  }

  const shipmentReferencesProperties = db
    .prepare("PRAGMA foreign_key_list(shipments)")
    .all()
    .some((foreignKey) => foreignKey.table === "properties");

  if (shipmentReferencesProperties) {
    db.pragma("foreign_keys = OFF");
    try {
      db.exec(`
        DROP INDEX IF EXISTS idx_shipments_property_date;
        DROP INDEX IF EXISTS idx_shipments_status;
        DROP INDEX IF EXISTS idx_shipments_batch_id;

        CREATE TABLE shipments_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id INTEGER NOT NULL REFERENCES tenants(id),
          property_id TEXT NOT NULL,
          batch_id INTEGER REFERENCES shipment_batches(id),
          shipment_date TEXT NOT NULL,
          minimum_next_shipment_date TEXT NOT NULL,
          tracking_number TEXT UNIQUE,
          status TEXT NOT NULL,
          source TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        INSERT INTO shipments_new
          (id, tenant_id, property_id, batch_id, shipment_date, minimum_next_shipment_date,
           tracking_number, status, source, created_at)
        SELECT id, tenant_id, property_id, batch_id, shipment_date, minimum_next_shipment_date,
               tracking_number, status, source, created_at
        FROM shipments;

        DROP TABLE shipments;
        ALTER TABLE shipments_new RENAME TO shipments;
      `);
    } finally {
      db.pragma("foreign_keys = ON");
    }
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_properties_property_id
      ON properties(property_id);
    CREATE INDEX IF NOT EXISTS idx_shipments_property_date
      ON shipments(property_id, shipment_date);
    CREATE INDEX IF NOT EXISTS idx_shipments_status
      ON shipments(status);
    CREATE INDEX IF NOT EXISTS idx_shipments_batch_id
      ON shipments(batch_id);
  `);
}

function normalizeEnrollmentRiders(db) {
  // Enrollments are static in this trial, so compute rider flags once during
  // migration/startup. The raw riders string remains unchanged for audit.
  const enrollments = db.prepare("SELECT id, riders FROM enrollments ORDER BY id").all();
  const update = db.prepare(`
    UPDATE enrollments
    SET normalized_rider_labels = @normalized_rider_labels
    WHERE id = @id
  `);

  const tx = db.transaction(() => {
    for (const enrollment of enrollments) {
      update.run({
        id: enrollment.id,
        normalized_rider_labels: JSON.stringify(normalizedRiderLabels(enrollment.riders)),
      });
    }
  });

  tx();
}

function seedOperationalData(db) {
  // Rebuild normalized property assignments and data-quality findings from the
  // current raw fixtures. Existing shipment rows are left alone.
  const tenants = db.prepare("SELECT * FROM tenants ORDER BY id").all();
  const normalized = normalizeProperties(loadRawProperties(), tenants);
  writeNormalizedPropertiesFile(normalized);

  const tx = db.transaction(() => {
    db.prepare("DELETE FROM data_quality_issues").run();
    db.prepare("DELETE FROM properties").run();

    const propertyDefinitions = new Map(
      normalized.normalizedProperties.map((property) => [property.id, property]),
    );

    const insertPropertyAssignment = db.prepare(`
      INSERT INTO properties
        (tenant_id, property_id, name, shipment_interval_days, notes)
      VALUES
        (@tenant_id, @property_id, @name, @shipment_interval_days, @notes)
    `);

    const insertIssue = db.prepare(`
      INSERT INTO data_quality_issues
        (issue_type, tenant_id, related_tenant_id, property_id, related_property_id, details, resolution)
      VALUES
        (@issue_type, @tenant_id, @related_tenant_id, @property_id, @related_property_id, @details, @resolution)
    `);

    for (const assignment of normalized.tenantProperties) {
      const property = propertyDefinitions.get(assignment.property_id);
      insertPropertyAssignment.run({
        tenant_id: assignment.tenant_id,
        property_id: assignment.property_id,
        name: property.name,
        shipment_interval_days: property.shipment_interval_days,
        notes: assignment.notes,
      });
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

    db.prepare(`
      UPDATE shipments
      SET property_id = (
        SELECT property_id
        FROM properties
        WHERE properties.tenant_id = shipments.tenant_id
      )
      WHERE EXISTS (
        SELECT 1
        FROM properties
        WHERE properties.tenant_id = shipments.tenant_id
      )
    `).run();
  });

  tx();
}

function recordHistoricalIssues(db) {
  // These issues do not block eligibility; they are surfaced so the reviewer
  // can see how fixture messiness was handled.
  const insertIssue = db.prepare(`
    INSERT INTO data_quality_issues
      (issue_type, tenant_id, property_id, details, resolution)
    VALUES
      (@issue_type, @tenant_id, @property_id, @details, @resolution)
  `);

  const tenantProperty = db
    .prepare("SELECT property_id FROM properties WHERE tenant_id = ?")
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
  // Historical rows are copied into shipments so cooldown logic can read one
  // table for both past shipments and export-created orders.
  const rows = db
    .prepare(`
      SELECT hs.*, p.property_id, p.shipment_interval_days
      FROM historical_shipments hs
      JOIN properties p ON p.tenant_id = hs.tenant_id
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
    normalizeEnrollmentRiders(db);
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
  normalizeEnrollmentRiders,
  normalizeHistoricalShipments,
  recordHistoricalIssues,
  seedOperationalData,
};
