# Air Filter Shipment Implementation Notes

## Project Goal

This implementation covers the first three requirements of the work trial:

- normalize property data;
- determine air-filter shipment eligibility;
- export eligible tenants to a CSV for the shipping partner;
- record exports as shipment orders so tenants/properties are not re-exported immediately.

I built the app as a React UI with an Express API and SQLite persistence. The React app is intentionally clean and operational: a date selector, a `Ship Batch` action, a reset action for demos, and a `Download` button after a batch is created.

## Schema Decisions

The original `tenants`, `enrollments`, and `historical_shipments` tables are treated as raw source data. I added normalized operational tables instead of changing the raw fixtures directly.

### `properties`

Stores the shipment cooldown groups and their intervals.

This is separate from `tenants` because one property has many tenants. If the interval lived directly on every tenant row, the same property interval would be duplicated many times and could become inconsistent.

### `tenant_properties`

Stores the current tenant-to-property assignment.

This table gives the app a clean `tenant_id -> property_id` relationship without mutating the provided `tenants` table. It also makes the distinction clear between a tenant's mailing address and the operational property group used for cooldowns.

### `shipments`

Stores all shipment/order records in one place.

Historical shipments are normalized into this table with `source = 'historical'` and `status = 'historical'`. Export-created rows use `source = 'export'` and `status = 'ordered'`. This lets the eligibility engine read one table instead of checking historical shipments and new exports separately.

### `shipment_batches`

Stores one CSV export run.

This is useful now because it groups all shipment rows created by one export and allows the same CSV to be downloaded again. It is useful later because a ShipStation import can be matched back to a batch, batch status can move from `exported` to `partially_imported` or `imported`, and manual review can be organized by batch.

The schema is:

```sql
CREATE TABLE shipment_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  as_of_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'exported',
  exported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  shipment_count INTEGER NOT NULL DEFAULT 0,
  csv_filename TEXT,
  notes TEXT
);
```

### `data_quality_issues`

Stores messy data findings and resolutions.

I used one general issue table instead of many issue-specific tables because these records are audit/debug information. A single table is enough for this project and keeps the schema understandable.

## Why The Core Tables Are Separate

I kept the core domain tables separate where the relationships are truly one-to-many:

- one property has many tenants;
- one export batch has many shipments;
- one tenant can have many shipments over time.

This avoids duplicating property intervals or batch metadata across rows. The design is normalized where it protects correctness, and pragmatic where extra tables would be unnecessary.

## Property vs Tenant Address

The tenant address in the database is the mailing address used for exports.

`properties.json` is the operational cooldown grouping file. It tells the system which tenants share a shipment interval. Therefore, if one tenant in a property group gets a filter, every tenant in that property group is on cooldown until the interval passes.

The property grouping wins over address assumptions because the fixture addresses are not consistent with the property group names.

## Data Issues Found

The initial scan found these issues:

- duplicate property id `prop-riverbend`;
- duplicate tenant assignment for tenant `135452`;
- duplicate tenant assignment for tenant `145566`;
- 36 tenant ids in the database missing from `properties.json`;
- duplicate tenant identity for Casey Morgan: `900001` and `900002`;
- one historical shipment dated `2026-05-15`, after the default eligibility date `2026-04-24`;
- one historical shipment for tenant `135452` with an old address that differs from the current tenant address.

All of these are surfaced in the Data Quality page and recorded in `data_quality_issues`.

## Data Cleanup Resolutions

I keep raw `properties.json` unchanged and generate `properties.normalized.json`.

The duplicate Riverbend property is renamed to `prop-riverbend-annex` because the source name is Riverbend Annex and it has a different shipment interval. Treating it as a separate property preserves its intended cooldown behavior.

If a tenant appears in two property groups, first assignment wins. This is deterministic and avoids guessing based on address.

Tenants missing from `properties.json` get address-based fallback properties with a 90-day interval. I chose 90 days because it is common in the fixture and safer than no cooldown.

For duplicate tenant identities, I preserve both raw tenant rows but exclude the non-canonical duplicate from operational eligibility/export. For Casey Morgan, the lower tenant id is the canonical row. This keeps the raw fixture auditable while making the operational data behave as if duplicates were removed.

## Rider Normalization

Riders are stored as strings like:

```text
{Credit Reporting,Airfilters Delivery ($4),Move-in Concierge}
```

The raw value stays in `enrollments.riders`. It is the original fixture string, such as:

```text
{Credit Reporting,Move-in Concierge,ID Theft Protection,Airfilters Delivery ($4),Late Payment Calls}
```

I normalize rider labels because the same business concept can appear with slightly different labels. In the fixture data, the relevant rider appears as labels such as:

- `Free Airfilters Delivery`;
- `Airfilters Delivery ($4)`.

Those should both mean: this tenant has the air-filter delivery add-on.

Because enrollments are static in this project, rider normalization runs during migration/startup, not when the user clicks `Ship Batch`.

I store two derived fields on `enrollments`:

- `normalized_rider_labels`: JSON text array of cleaned labels, useful for audit/debugging;
- `has_air_filter_delivery`: integer boolean, `1` when the enrollment contains an air-filter delivery rider.

The source of truth remains `enrollments.riders`; the derived fields are recalculated by `src/server/migrate.js` using `src/server/services/normalizeRiders.js`.

I chose not to add separate `riders` and `enrollment_riders` tables for this milestone because the app only needs one business question:

```text
Does this active Renters Kit enrollment include air-filter delivery?
```

If this became a broader product-catalog system with mutable rider definitions, I would add normalized tables such as `riders` and `enrollment_riders`. For this work trial, derived enrollment fields keep the schema smaller while avoiding reparsing rider strings on each export.

The rider parser:

- removes surrounding braces;
- splits on commas;
- trims whitespace;
- lowercases;
- makes `Airfilters`, `Air Filters`, `air filters`, `air-filters`, and `filters for air` equivalent;
- removes punctuation and price/details in parentheses;
- treats labels as an air-filter delivery rider only when the normalized label clearly contains both an air-filter term and `delivery`, with explicit handling for the known fixture labels.

The code lives in `src/server/services/normalizeRiders.js`.

## Cooldown Algorithm

The main eligibility logic lives in `src/server/services/eligibilityService.js`.

For each selected `asOf` date, the query only considers shipments where:

```sql
shipment_date <= :asOf
```

This prevents future rows from affecting earlier eligibility. For example, the fixture has a historical shipment on `2026-05-15`; it must not affect the default `2026-04-24` eligibility run.

Date math uses date-only UTC parsing so time zones do not shift calendar days:

```js
function daysBetween(startDate, endDate) {
  const [sy, sm, sd] = startDate.split("-").map(Number);
  const [ey, em, ed] = endDate.split("-").map(Number);
  return Math.floor(
    (Date.UTC(ey, em - 1, ed) - Date.UTC(sy, sm - 1, sd)) / 86_400_000
  );
}
```

A property is off cooldown when:

```js
!lastShipmentDate || daysBetween(lastShipmentDate, asOf) >= interval
```

## From SQLite Rows To O(1) Lookups

SQLite returns arrays of rows. The eligibility service converts those rows into JavaScript `Map` objects once per run:

```js
const tenantToProperty = new Map();
const propertyIntervals = new Map();
const propertyLastShipmentDate = new Map();
```

Rows are loaded and indexed like this:

```js
for (const row of assignments) {
  tenantToProperty.set(row.tenant_id, row.property_id);
}

for (const row of properties) {
  propertyIntervals.set(row.id, row.shipment_interval_days);
}

for (const row of latestShipments) {
  propertyLastShipmentDate.set(row.property_id, row.last_shipment_date);
}
```

Then each enrollment-qualified tenant can be evaluated with average-case `O(1)` lookups:

```js
const propertyId = tenantToProperty.get(tenant.id);
const interval = propertyIntervals.get(propertyId);
const lastShipmentDate = propertyLastShipmentDate.get(propertyId);
```

This avoids repeatedly scanning all properties or all shipments for every tenant.

## One-Pass Export Selection

Same-property conflicts are handled during candidate selection with a `Set`:

```js
const selectedPropertyIds = new Set();
const selectedTenants = [];

for (const tenant of enrollmentQualifiedTenants) {
  const propertyId = tenantToProperty.get(tenant.id);
  const interval = propertyIntervals.get(propertyId);
  const lastShipmentDate = propertyLastShipmentDate.get(propertyId);

  const cooldownExpired =
    !lastShipmentDate || daysBetween(lastShipmentDate, asOf) >= interval;

  if (!cooldownExpired) continue;
  if (selectedPropertyIds.has(propertyId)) continue;

  selectedTenants.push(tenant);
  selectedPropertyIds.add(propertyId);
}
```

`Set.has()` is average-case `O(1)`, so the service does not need to select everyone and clean up duplicate properties later. The first eligible tenant in deterministic `tenant_id ASC` order wins for the batch.

## Export Semantics

Exporting means the system has ordered a shipment from the partner, even if tracking is not known yet.

Therefore, export-created shipment rows use:

```text
status = ordered
source = export
```

Ordered shipments count for cooldown immediately. Otherwise, running the export twice could create duplicate orders before the shipping partner returns tracking data.

Cooldown-counting statuses are:

- `historical`;
- `ordered`;
- `shipped`;
- `delivered`;
- `confirmed`.

`cancelled` does not count.

## Demo Reset

Because this is a work-trial/demo app, I added a reset action at `POST /api/reset-demo-state` and a Reset Demo button on the shipment batch page.

The reset only deletes rows created by the export flow:

- `shipments` where `source = 'export'`;
- all `shipment_batches`.

It intentionally keeps:

- raw source tables;
- normalized properties;
- tenant-property assignments;
- data-quality issues;
- historical shipments.

This lets the reviewer run the `2026-04-24` export flow, observe that ordered shipments immediately start cooldown, then reset back to the seeded operational state and rerun the demo.

## UI Flow

The first screen does not pre-render eligible tenants or excluded tenants. Instead, the operator chooses an `asOf` date and clicks `Ship Batch`.

`Ship Batch` runs the eligibility engine, creates one `shipment_batches` row, creates `ordered` shipment rows, and returns the persisted batch. The UI then shows a separate `Download` button for the generated CSV.

I removed the analytics-style counts and the excluded-tenant table from the main UI because they made the first milestone feel more like a dashboard than a shipping workflow. The underlying API still exposes eligibility detail for debugging and future screens.

## CSV Columns

The export includes:

- `tenant_id`: stable internal reference for debugging and import reconciliation;
- `property_id`: shows the cooldown group used;
- `batch_id`: ties the row to one export run;
- `first_name`, `last_name`: recipient name split into separate fields so downstream systems can choose how to format the label;
- `address1`, `address2`, `city`, `state`, `zip`: required delivery address fields;
- `shipment_date`: date the order was generated;
- `minimum_next_shipment_date`: explains future cooldown behavior.

I intentionally do not include tracking number because it does not exist until partner import. I also do not include enrollment/rider data because that is internal eligibility evidence, not shipping instruction data.

ZIP codes are exported exactly as stored in SQLite. For example, tenant `175236` has zip `06323`, and the raw CSV contains `06323` without an apostrophe. Spreadsheet apps may display a warning or show an apostrophe in the formula bar because they are treating the ZIP as text to preserve the leading zero. That is expected; ZIP codes should be text, not numbers.

## Known Limitations And Future Work

The first milestone does not implement the ShipStation import/manual review requirement yet.

The schema is prepared for it: import can update `shipments.tracking_number`, add future `shipment_import_rows`, and store parsed filter sizes in a separate one-to-many table.

For later import matching, I would use normalized full name plus normalized address and zip as the highest-confidence match. Rows like duplicate Casey Morgan should go to manual review because two tenant ids represent the same identity/address.
