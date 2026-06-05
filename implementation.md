# Air Filter Shipment Implementation Notes

## Project Goal

This implementation now covers the four main workflow requirements of the work trial:

- normalize property data;
- determine air-filter shipment eligibility;
- export eligible tenants to a CSV for the shipping partner;
- record exports as shipment orders so tenants/properties are not re-exported immediately;
- import a ShipStation-style shipment file, match rows back to tenants/shipments, parse filter sizes, and surface rows that need manual review.

I built the app as a React UI with an Express API and SQLite persistence. The React app is intentionally clean and operational rather than dashboard-heavy. The shipping side has a date selector, a `Ship Batch` action, a reset action for demos, and a `Download` button after a batch is created. The import side has a CSV file picker, an `Import Selected CSV` action, and one tabbed results area where the reviewer can switch between `Matched Rows`, `Manual Review`, and `Flags` without scrolling through unrelated sections.

## Schema Decisions

The original `tenants`, `enrollments`, and `historical_shipments` tables are treated as raw source data. However, an additional column is added to the `enrollments` table for normalized riders through a migration that occurs when the web app starts up. This normalizes rider labels like `"Free Airfilters Delivery"`, `"Airfilters Delivery ($4)"`, or variants such as air filter, airFilter, Air Filter, and filters for air into a consistent form. This makes it easier to audit whether the enrollment has an air-filter rider for eligibility.

The derived column is:

```sql
ALTER TABLE enrollments ADD COLUMN normalized_rider_labels TEXT;
```

I originally considered storing a `has_air_filter_delivery` boolean, but chose not to keep it because each enrollment has only a small rider list, so checking whether the rider list contains an air-filter delivery label is cheap. This avoids the creation of another extra column in the data schema that is largely unnessecary.

### `properties`

Stores the relationship between the tenant to property_id to property name.

The schema is:

```sql
CREATE TABLE properties (
  tenant_id INTEGER PRIMARY KEY REFERENCES tenants(id),
  property_id TEXT NOT NULL,
  name TEXT NOT NULL,
  shipment_interval_days INTEGER NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

`tenant_id` is the primary key because each tenant has one current operational property assignment. `property_id` is still the cooldown group id. Multiple rows can share the same `property_id`, which means those tenants share the same shipment interval/cooldown behavior.

### `shipments`

Stores all shipment/order records in one place. For each eligible tenant that is shipped out it records the tenant, property_id, date shipped out, and the minimum date that that property group is eligible again to get another air filter.

Historical shipments are normalized into this table with `source = 'historical'` and `status = 'historical'`. Export-created rows use `source = 'export'` and `status = 'ordered'`.

### `shipment_import_rows`

Stores one raw row from the imported ShipStation file, plus the matching result.

This table is necessary because import matching is not always automatic. If a row cannot be matched with high confidence, the app still needs to preserve the raw CSV data, the match reason, candidate evidence, and the review status. Without this table, an unmatched row would either be lost or would have to be forced into the `shipments` table before a tenant is known.

The schema is:

```sql
CREATE TABLE shipment_import_rows (
  id INTEGER PRIMARY KEY,
  filename TEXT,
  imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
  filter_sizes TEXT NOT NULL DEFAULT '[]',
  reviewed_at TEXT
);
```

The important statuses are:

- `auto_matched`: the system matched the row automatically;
- `needs_review`: a human must confirm or dismiss the row;
- `manually_matched`: a human confirmed a tenant candidate;
- `dismissed`: a human decided the row should not create/update a shipment.

The `matched_fields`, `conflicting_fields`, and `filter_sizes` columns are JSON arrays. I chose this because these values are row-level explanations, not entities the app needs to query independently for v1.

`filter_sizes` stores the normalized filter-size results directly on the imported row. Each entry preserves the raw value and stores the normalized value, numeric dimensions, parse status, and parse error when applicable.

Example stored JSON:

```json
[
  {
    "raw_value": "25x16-1/2x1",
    "normalized_value": "25x16.5x1",
    "width_inches": 25,
    "height_inches": 16.5,
    "depth_inches": 1,
    "parse_status": "parsed",
    "parse_error": null
  }
]
```

This is less queryable than a separate `shipment_filter_sizes` table, but it is simpler and matches the current UI: filter sizes are always reviewed in the context of their imported CSV row.

### `data_quality_issues`

Stores messy data findings and resolutions.

I used one general issue table instead of many issue-specific tables because these records are audit/debug information. A single table is enough for this project and keeps the schema understandable.

### Indexes

I added indexes around the relationships and query patterns that are used repeatedly:

```sql
CREATE INDEX idx_properties_property_id
  ON properties(property_id);

CREATE INDEX idx_shipments_property_date
  ON shipments(property_id, shipment_date);

CREATE INDEX idx_shipments_status
  ON shipments(status);

CREATE INDEX idx_import_rows_status
  ON shipment_import_rows(match_status);

CREATE INDEX idx_import_rows_tenant
  ON shipment_import_rows(matched_tenant_id);
```

`idx_properties_property_id` helps queries that group or inspect tenants by cooldown group. The most important eligibility index is `idx_shipments_property_date`, because cooldown checks need to find the latest shipment per property as of a selected date. The import indexes help the UI load review rows by status and tenant.

## Why The Core Tables Are Separate

I kept the core domain tables separate where the relationships are truly one-to-many and where separate state prevents real confusion:

- one tenant can have many shipments over time;
- one imported row can have one matching result and one row-level filter-size JSON payload.

I did not keep `properties` and tenant assignment separate because the app only uses one current assignment per tenant. The combined `properties` table is less normalized, but easier to work with for this project. The design is normalized where it protects correctness, and pragmatic where extra tables would be unnecessary.

The import design follows the same principle. `shipment_import_rows` is separate from `shipments` because an imported CSV row might not have a confirmed tenant yet. I chose not to keep `shipment_filter_sizes` separate after simplification because the app displays and reviews size data only inside the import row context.

I intentionally did not add a `shipment_import_candidates` table for v1. Candidate tenants are computed from current tenant data when the review UI loads. That keeps the database smaller and avoids stale candidate rows if tenant data is corrected. The tradeoff is that candidates are recomputed on demand, but the dataset is small and the matcher uses lookup maps to avoid scanning work that would matter at this scale.

## Property vs Tenant Address

The tenant address in the database is the mailing address used for exports.

`properties.json` is the operational cooldown grouping file. It tells the system which tenants share a shipment interval. Therefore, if one tenant in a property group gets a filter, every tenant in that property group is on cooldown until the interval passes.

The property grouping wins over address assumptions because the fixture addresses are not consistent with the property group names.

## Data Issues Found

These data issues were found:

- duplicate property id `prop-riverbend`;
- duplicate tenant assignment for tenant `135452`;
- duplicate tenant assignment for tenant `145566`;
- 36 tenant ids in the database missing from `properties.json`;
- duplicate tenant identity for Casey Morgan: `900001` and `900002`;
- one historical shipment dated `2026-05-15`, after the default eligibility date `2026-04-24`;
- one historical shipment for tenant `135452` with an old address that differs from the current tenant address.

All of these are recorded in `data_quality_issues` and exposed through `GET /api/data-quality`.

## Data Cleanup Resolutions

I kept the original `properties.json` unchanged and generated a new `properties.normalized.json`.

The duplicate Riverbend property is renamed to `prop-riverbend-annex` because the source name is Riverbend Annex and it has a different shipment interval, so it seems right to treat it as a separate entity.

If a tenant appears in two property groups, first assignment wins and the duplicate is removed.

Tenants missing from `properties.json` are assigned deterministic address-based fallback properties with a 90-day interval.

```text
id: fallback-{normalized-address}
name: Fallback: {address1}
shipment_interval_days: 90
```

I intially had the unassigned tenants into one shared `missing-property` group, but that only led to 3 eligible tenants because one historical shipment for any missing-property tenant put every other missing-property tenant on cooldown. Instead of inventing a relationship between unrelated tenants, I used a fallback of using the address as their property_id and property name. This results in 32 eligible tenats on`2026-04-24` instead of`3`.

For duplicate tenants, the webapp startup will remove duplicate tenants from the database. For Casey Morgan, tenant `900001` is kept and tenant `900002` is deleted along with related enrollments, historical shipments, import rows, and shipment rows. This means reset does not bring the duplicate back. This would mean that there could be data lost from the deletion of the duplicate data, but that is a result from user error and not on our side.

## Rider Normalization

Riders are stored as strings like:

```text
{Credit Reporting,Airfilters Delivery ($4),Move-in Concierge}
```

The raw value stays in `enrollments.riders`. It is the original fixture string, such as:

```text
{Credit Reporting,Move-in Concierge,ID Theft Protection,Airfilters Delivery ($4),Late Payment Calls}
```

I normalize rider labels because intended meaning can appear with slightly different wording. In the fixture data, the relevant rider appears as labels such as:

- `Free Airfilters Delivery`;
- `Airfilters Delivery ($4)`.

Those should both mean that this tenant has the air-filter delivery add-on.

Because enrollments are static in this project, normalized rider labels are recalculated during migration/startup.

I store one derived field on `enrollments`:

- `normalized_rider_labels`: JSON text array of cleaned labels, useful for audit/debugging.

The source of truth remains `enrollments.riders`; the derived field is recalculated by `src/server/migrate.js` using `src/server/services/normalizeRiders.js`.

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

This also prevents future rows from affecting earlier eligibility. For example, the fixture has a historical shipment on `2026-05-15`; it must not affect the default `2026-04-24` eligibility run. Essentially it just doesn't look at future values for determining eligibility

Date math uses date-only UTC parsing so time zones do not shift calendar days:

```js
function daysBetween(startDate, endDate) {
  const [sy, sm, sd] = startDate.split("-").map(Number);
  const [ey, em, ed] = endDate.split("-").map(Number);
  return Math.floor(
    (Date.UTC(ey, em - 1, ed) - Date.UTC(sy, sm - 1, sd)) / 86_400_000,
  );
}
```

A property is off cooldown when:

```js
!lastShipmentDate || daysBetween(lastShipmentDate, asOf) >= interval;
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

## ShipStation Import And Manual Review

The Import tab handles the fourth requirement. It imports a selected ShipStation-style CSV file, stores every raw row, attempts tenant matching, parses filter sizes, updates or creates shipment records, and exposes review/flag queues.

The app handles the import of a CSV file that contains shipping data. An additional exemple `fixtures\matching-demo-shipstation.csv` was generated to further test cases where a perfect match is not found. 

The shipstation import handles and covers these cases:

- exact full-name/address matches;
- address and unit conflicts that require manual review;
- missing required address fields;
- blank filter sizes;
- ambiguous range-like sizes;
- unsupported semantic text;
- malformed/missing dimensions;
- valid mixed-fraction and word-based size normalization.

The UI exposes three result views as tabs inside one Import Results section:

- matched rows: rows that confidently matched to tenants;
- manual review queue: rows that need a human tenant decision;
- flags: missing, ambiguous, or unusable data that needs follow-up.

### Import Flow

The import logic lives in `src/server/services/importService.js`.

The flow is:

1. Read the selected CSV file in React and post its filename plus CSV text to the API.
2. Clear the previous `shipment_import_rows` so the UI shows only the current import file.
3. Build tenant matching indexes from the current cleaned `tenants` table.
4. For each CSV row, normalize the row into the fields the matcher expects.
5. Check required fields: name, address1, city, state, ZIP, shipment id, and ship date.
6. Parse `custom_field_1` into normalized filter-size JSON.
7. Score plausible tenant candidates.
8. Auto-match only when the match is strong and unambiguous.
9. Store the raw CSV row, match result, and filter-size JSON in `shipment_import_rows`.
10. Return the current import detail for the React UI.

The import was designed to be tolerant, where a bad row or bad filter-size value does not fail the whole file. The row is stored, the issue is recorded, and the UI surfaces it in `Manual Review` or `Flags`.

When a row auto-matches or is manually confirmed, the app creates or updates a shipment:

- if the tracking/shipment id already exists in `shipments`, update that shipment to `shipped`;
- otherwise, if the tenant already has an `ordered` shipment, attach the tracking id and mark it `shipped`;
- otherwise, create a new `shipments` row with `source = 'shipstation_import'` and `status = 'shipped'`.

That three-step behavior lets the import work both as a follow-up to exports created by this app and as a backfill/import of shipments that already exist in the partner file.

### Matching Confidence

The import uses combo matching instead of name-only matching. Name alone is too risky because duplicate identities can exist and people can share common names.

The matcher normalizes:

- full name;
- address1;
- address2;
- city;
- state;
- ZIP

The matched rows table still shows matched-field badges so the reviewer can see why the automatic match was trusted.

The manual review queue is intentionally simpler. Each review item shows the raw recipient name and full address from ShipStation, each candidate tenant's name and full address, a `Confidence score`, and a short `Not matching` line.

Matched rows, the manual review queue, and flags are shown as tabs inside the Import Results section instead of as stacked sections. This keeps the import page compact and lets the reviewer focus on one type of follow-up at a time: automatic matches, tenant matching, or data-quality flags.

### How Import Scoring Works

The matcher does **not** scan every tenant row for every CSV row. Instead, it does two phases:

1. **Build in-memory lookup indexes once per import run** (JavaScript `Map`s created by `buildTenantIndexes()`).
2. **For each CSV row, use those indexes to fetch a small candidate set**, then score only those candidates.

This is what allows`O(1)` lookup: `Map.get(key)` is average-case `O(1)`, so looking up “tenants with this normalized name” or “tenants with this normalized address+ZIP” is constant-time *per lookup*. The full match is not purely `O(1)` end-to-end because candidates still need to be scored and sorted, but in practice the candidate set is small, so this avoids a much larger `O(number_of_tenants)` scan for each import row.

Note that these matcher “indexes” are **not SQLite indexes**. SQLite indexes speed up SQL queries. Here, the matcher indexes are in-memory hash maps used after the tenant rows have already been loaded.

#### Code path: import row -> `findMatch(row, indexes)`

The import service loads tenants once, builds matcher indexes once, then calls the matcher for each CSV row:

```js
const tenants = db.prepare("SELECT * FROM tenants ORDER BY id").all();
const indexes = buildTenantIndexes(tenants, getDuplicateTenantIds(db));

for (const rawRow of rows) {
  const row = {
    ship_date: rawRow.ship_date ? toIsoDate(rawRow.ship_date) : null,
    shipment_id: rawRow.shipment_id || null,
    name: rawRow.name || "",
    address1: rawRow.address1 || null,
    address2: rawRow.address2 || null,
    city: rawRow.city || null,
    state: rawRow.state || null,
    zip: rawRow.zip || null,
    custom_field_1: rawRow.custom_field_1 || "",
    carrier: rawRow.carrier || null,
  };

  const requiredIssue = requiredRowIssue(rawRow);
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
}
```

This is why building the indexes upfront matters: `findMatch()` can now do a handful of `Map.get(...)` lookups instead of scanning every tenant.

#### Code path: building the matcher indexes (`buildTenantIndexes`)

`buildTenantIndexes()` normalizes each tenant once and inserts them into multiple lookup maps:

```js
const indexes = {
  byName: new Map(),
  byAddress1Zip: new Map(),
  byAddress1: new Map(),
  byAddress2: new Map(),
  byZip: new Map(),
};

for (const tenant of tenants) {
  const indexedTenant = {
    ...tenant,
    isDuplicateIdentity: duplicateTenantIds.has(tenant.id),
    normalizedName: normalizeText(tenantFullName(tenant)),
    normalizedAddress1: normalizeAddressPart(tenant.address1),
    normalizedAddress2: normalizeAddressPart(tenant.address2),
    normalizedCity: normalizeAddressPart(tenant.city),
    normalizedState: normalizeAddressPart(tenant.state),
    normalizedZip: normalizeZip(tenant.zip),
  };

  addToIndex(indexes.byName, indexedTenant.normalizedName, indexedTenant);
  addToIndex(
    indexes.byAddress1Zip,
    `${indexedTenant.normalizedAddress1}|${indexedTenant.normalizedZip}`,
    indexedTenant,
  );
  addToIndex(
    indexes.byAddress1,
    indexedTenant.normalizedAddress1,
    indexedTenant,
  );
  addToIndex(
    indexes.byAddress2,
    indexedTenant.normalizedAddress2,
    indexedTenant,
  );
  addToIndex(indexes.byZip, indexedTenant.normalizedZip, indexedTenant);
}
```

Each `Map` key points to an array of tenants that share that exact normalized value. Later, candidate retrieval is just `indexes.byAddress1Zip.get(key)` which is average-case `O(1)`.

#### Code path: candidate retrieval (`collectCandidateTenants`)

For one import row, the matcher tries several index lookups and unions the results (deduped by tenant id):

```js
addAll(indexes.byName.get(normalized.normalizedName));
addAll(
  indexes.byAddress1Zip.get(
    `${normalized.normalizedAddress1}|${normalized.normalizedZip}`,
  ),
);
addAll(indexes.byAddress1.get(normalized.normalizedAddress1));
addAll(indexes.byZip.get(normalized.normalizedZip));

if (byId.size === 0) {
  addAll(indexes.byAddress2.get(normalized.normalizedAddress2));
}
```

This is the “fast” part: a few `Map.get(...)` calls produce a shortlist. The row is not matched yet — it is just gathering plausible candidates.

#### Code path: scoring + auto-match decision (`findMatch`)

Each candidate is scored additively, then the best candidate is auto-matched only when it is strong and unambiguous:

```js
const candidates = collectCandidateTenants(row, indexes)
  .map((tenant) => scoreCandidate(row, tenant))
  .filter((candidate) => candidate.score >= 50)
  .sort((a, b) => b.score - a.score || a.tenant.id - b.tenant.id);

const top = candidates[0] || null;
const topTies = top
  ? candidates.filter((candidate) => candidate.score === top.score)
  : [];
const autoMatch =
  top &&
  top.score >= 95 &&
  topTies.length === 1 &&
  !top.hasAddress2Conflict &&
  !top.isDuplicateIdentity;
```

So the overall runtime per import row is:

- **Candidate retrieval**: a few average-case `O(1)` map lookups
- **Scoring**: `O(k)` for k = number of candidates returned
- **Sorting**: `O(k log k)` (but `k` is typically small)

The current candidate-gathering indexes are:

- normalized full name;
- normalized `address1 + ZIP`;
- normalized `address1`;
- normalized ZIP;
- normalized `address2` as a fallback only when no other candidate is found.

For each import row, the flow is:

1. Normalize the import row’s identity/address fields (name, address parts, city/state, ZIP).
2. Call `Map.get(...)` on several indexes to collect a shortlist of plausible tenant records (deduped by tenant id).
3. Score each candidate using additive field points and track conflicts (especially `address2` conflicts and duplicate-identity flags).
4. Sort candidates by score and decide whether the top candidate is strong and unambiguous enough to auto-match; otherwise the row goes to manual review.

The score is additive and totals 100 points:


| Field     | Points | Why it matters                                                                                  |
| --------- | ------ | ----------------------------------------------------------------------------------------------- |
| Full name | 40     | Strong identity signal, but not enough alone because duplicates and shared names can exist.     |
| Address1  | 25     | Strong location signal for the building/street address.                                         |
| Address2  | 10     | Important unit/apartment signal; conflicts force review.                                        |
| City      | 7      | Supporting address signal.                                                                      |
| State     | 5      | Supporting address signal.                                                                      |
| ZIP       | 13     | Strong supporting address signal; ZIPs are normalized so values like `6323` compare as `06323`. |


Score interpretation:

- `95-100`: very strong match. It can auto-match only if it is the single top candidate, there is no duplicate identity issue, and there is no `address2` conflict.
- `90-94`: strong evidence, but still needs confirmation. In this dataset, this often means name, street, city, state, and ZIP match, but the unit evidence is missing or not strong enough.
- `50-89`: plausible candidate for manual review. The UI shows the candidate so a person can decide.
- below `50`: too weak to show as a useful candidate.

The `95` threshold is intentionally conservative. A score of `90` can still be wrong in a large building if `address2` is missing or mismatched, so it is not automatically confirmed.

Auto-match requires:

- score of at least `95`;
- exactly one top candidate;
- no duplicate tenant identity issue;
- no `address2` conflict.

A row with otherwise strong evidence but conflicting `address2` still goes to manual review. `address2` often contains apartment or unit information, and in a large building the street address alone may not identify the correct tenant.

Partial matches are still useful for manual review. For example, an old-address row can still show a plausible tenant if the full name, city, state, or ZIP match. This gives the user options without letting the system over-confidently auto-match.

### Manual Review Decisions

The Manual Review tab shows only the information needed to decide whether a raw ShipStation row belongs to a tenant:

- raw recipient name;
- raw full address;
- candidate tenant name;
- candidate full address;
- confidence score;
- fields that do not match.

I originally showed more raw technical fields and match badges in the review card, but simplified it because the human decision is not about inspecting every column. It is about deciding whether the row and candidate represent the same person/address. The matched-field badges remain in the Matched Rows audit table where they are useful for explaining automatic matches.

Manual review supports two actions:

- `Confirm Match`: creates or updates the shipment as `shipped`, attaches parsed filter sizes, and changes the row to `manually_matched`;
- `Dismiss Row`: marks the row `dismissed` so it no longer blocks the review queue.

Dismiss is important because some partner rows may be irrelevant, duplicated, or too ambiguous to resolve during the current workflow. It gives the reviewer a way to clear the queue without deleting the audit record.

### Shipment Status From Import

ShipStation import updates matched shipments to:

```text
status = shipped
```

The CSV proves that a shipment/tracking event exists. It does not prove successful carrier delivery. delivered should be reserved for a future carrier delivery confirmation.

If an imported tracking id already exists on a normalized historical shipment, the existing shipment is updated to `shipped` for the import demo. Reset restores historical shipment rows back to `historical`.

### Filter Size Parsing

Filters describe what physical filter dimensions were shipped.

The app stores:

- `raw_value`: exactly what ShipStation sent;
- `normalized_value`: standardized parsed value when possible;
- numeric width/height/depth fields;
- parse status and parse error.

Example:

```text
raw_value: 25x16-1/2x1
normalized_value: 25x16.5x1
width_inches: 25
height_inches: 16.5
depth_inches: 1
```

In this context, `16-1/2` means sixteen and one half, not a range. If a true range appears, such as `16-20x25x1`, the parser does not guess and marks the token for review.

The parser also supports simple semantic text such as:

```text
twenty-by-twenty -> 20x20
```

Unsupported semantic text becomes a flag. Ex. `twentyish-by-twenty`

## Demo Reset

Because this is a work-trial/demo app, I added a reset action at `POST /api/reset-demo-state` and a Reset Demo button on the shipment page.

The reset deletes rows created by the demo workflows:

- `shipments` where `source = 'export'`;
- `shipments` where `source = 'shipstation_import'`;
- all `shipment_import_rows`.

It also restores normalized historical shipments back to `status = 'historical'` if an import run temporarily updated an existing historical tracking number to `shipped`.

It intentionally keeps:

- raw source tables;
- normalized properties;
- current property assignments in `properties`;
- data-quality issues;
- historical shipments.

This lets the reviewer run the `2026-04-24` export flow, observe that ordered shipments immediately start cooldown, import the ShipStation file, inspect review/flag behavior, then reset back to the seeded operational state and rerun the demo.

## UI Flow

The first screen does not pre-render eligible tenants or excluded tenants. Instead, the operator chooses an `asOf` date and clicks `Ship Batch`.

`Ship Batch` runs the eligibility engine, creates `ordered` shipment rows, and returns the generated CSV to the browser. The UI then shows a separate `Download` button for that CSV.

I removed the analytics-style counts and the excluded-tenant table from the main shipping UI because they made the page feel more like a dashboard than a shipping workflow. The underlying API still exposes eligibility detail for debugging and future screens.

The Import tab follows the same operational style. It does not show a large dashboard by default. The operator chooses a CSV file, clicks `Import Selected CSV`, then the app shows summary counts and a single tabbed results area:

- `Matched Rows`: automatically matched import rows with match evidence;
- `Manual Review`: rows that need a human tenant decision;
- `Flags`: missing, ambiguous, or unusable data.

I removed the separate `Size warnings` indicator from the UI and database. Size issues are represented as flag rows derived from `shipment_import_rows.filter_sizes`.

## API Surface

The main API endpoints are:

- `GET /api/eligibility?asOf=YYYY-MM-DD`: returns eligibility detail for a selected date;
- `POST /api/exports`: runs eligibility, creates `ordered` shipments, and returns the CSV;
- `GET /api/shipments`: lists shipment/order rows;
- `GET /api/data-quality`: lists recorded fixture issues and resolutions;
- `POST /api/reset-demo-state`: clears demo-created export/import state;
- `POST /api/imports/shipstation`: imports CSV text posted by the React file picker;
- `GET /api/imports`: returns the current import rows with matched rows, review rows, and flags;
- `GET /api/import-rows/:id/candidates`: recomputes candidate tenants for one review row;
- `POST /api/import-rows/:id/confirm`: manually confirms a candidate tenant;
- `POST /api/import-rows/:id/dismiss`: dismisses an unresolved import row.

I used explicit endpoints instead of hiding everything behind one generic import endpoint because each operation has a different workflow meaning: importing a file, reviewing candidates, confirming a tenant, and dismissing a row are separate user actions.

## CSV Columns

The export includes:

- `tenant_id`: stable internal reference for debugging and import reconciliation;
- `property_id`: shows the cooldown group used;
- `first_name`, `last_name`: recipient name split into separate fields so downstream systems can choose how to format the label;
- `address1`, `address2`, `city`, `state`, `zip`: required delivery address fields;
- `shipment_date`: date the order was generated;
- `minimum_next_shipment_date`: explains future cooldown behavior.

I intentionally do not include tracking number because it does not exist until partner import. I also do not include enrollment/rider data because that is internal eligibility evidence, not shipping instruction data.

ZIP codes are exported exactly as stored in SQLite. For example, tenant `175236` has zip `06323`, and the raw CSV contains `06323` without an apostrophe. Spreadsheet apps may display a warning or show an apostrophe in the formula bar because they are treating the ZIP as text to preserve the leading zero. That is expected; ZIP codes should be text, not numbers.

### Unusable Size Data And Follow-up

Unusable size data should not fail the whole import. The app stores the raw value, the parse error, and enough context for a human to follow up.

Blank size:

```text
custom_field_1 = ""
raw_value: ""
parse_status: needs_review
parse_error: "No filter size provided"
follow-up: Contact tenant/property manager or check prior shipment/order notes.
```

Unsupported semantic text:

```text
custom_field_1 = "twentyish by twenty"
raw_value: "twentyish by twenty"
parse_status: needs_review
parse_error: "Unsupported word-based dimension"
follow-up: Human needs to interpret whether this means 20x20 or something else.
```

Ambiguous range or hyphen:

```text
custom_field_1 = "16-20x25x1"
raw_value: "16-20x25x1"
parse_status: needs_review
parse_error: "Dimension appears to contain a range or ambiguous hyphen"
follow-up: Review original ShipStation order or contact fulfillment partner.
```

Missing dimension:

```text
custom_field_1 = "20x"
raw_value: "20x"
parse_status: needs_review
parse_error: "Missing required dimension"
follow-up: Check the source order for the missing dimension.
```

Flags are not stored in a separate table. They are derived from `shipment_import_rows.match_status`, `shipment_import_rows.match_reason`, and the `filter_sizes` JSON stored on the same row.

## Known Limitations And Future Work

The import now supports choosing a CSV file in the browser. A production version would add stronger upload validation, larger file-size handling, and probably background processing for large imports.

Manual review currently supports confirm and dismiss. A fuller operations tool would also let the reviewer edit parsed filter sizes, correct raw address fields, and leave notes explaining why a row was dismissed.

The candidate matcher is deterministic and explainable, but it is still rule-based. For a larger dataset, I would add stronger address normalization, unit parsing, phonetic or fuzzy name matching, and more automated tests around false positives.

The app stores import flags as derived UI data from `shipment_import_rows` instead of a separate `flags` table. That is a good v1 choice because it avoids duplicating issue state. If flags later need assignment, comments, due dates, or resolution history, I would add a real `review_flags` table.



For future, I would first clean up the UI to make everything much more clean and sleek. I would also then consider the scalability for the platform, and start to consider a larger database instead of using a sqllite. 