"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { daysBetween } = require("../src/server/utils/dates");
const { hasAirFilterDeliveryRider } = require("../src/server/services/normalizeRiders");
const { normalizeProperties } = require("../src/server/services/normalizeProperties");
const { toCsv } = require("../src/server/services/exportService");
const { parseFilterSizes, parseSizeToken } = require("../src/server/services/filterSizeService");
const { buildTenantIndexes, findMatch, normalizeZip } = require("../src/server/services/importMatchingService");

test("normalizes known air-filter rider labels", () => {
  assert.equal(hasAirFilterDeliveryRider("{Free Airfilters Delivery}"), true);
  assert.equal(hasAirFilterDeliveryRider("{Airfilters Delivery ($4)}"), true);
  assert.equal(hasAirFilterDeliveryRider("{AIR FILTERS delivery}"), true);
  assert.equal(hasAirFilterDeliveryRider("{Air-filters Delivery (promo)}"), true);
  assert.equal(hasAirFilterDeliveryRider("{Filters for Air Delivery}"), true);
  assert.equal(hasAirFilterDeliveryRider("{Credit Reporting,Move-in Concierge}"), false);
  assert.equal(hasAirFilterDeliveryRider("{Air Filter Replacement}"), false);
});

test("calculates date-only day differences", () => {
  assert.equal(daysBetween("2026-04-10", "2026-04-24"), 14);
  assert.equal(daysBetween("2026-04-24", "2026-04-10"), -14);
});

test("normalizes duplicate property ids, duplicate tenant assignments, and missing-property tenants", () => {
  const rawProperties = [
    {
      id: "prop-riverbend",
      name: "Riverbend",
      shipment_interval_days: 90,
      tenant_ids: [1, 2],
    },
    {
      id: "prop-riverbend",
      name: "Riverbend Annex",
      shipment_interval_days: 45,
      tenant_ids: [2],
    },
  ];

  const tenants = [
    {
      id: 1,
      first_name: "A",
      last_name: "One",
      address1: "1 Main",
      address2: "",
      city: "Town",
      state: "NY",
      zip: "10001",
    },
    {
      id: 2,
      first_name: "B",
      last_name: "Two",
      address1: "2 Main",
      address2: "",
      city: "Town",
      state: "NY",
      zip: "10002",
    },
    {
      id: 3,
      first_name: "C",
      last_name: "Three",
      address1: "3 Main",
      address2: "Apt 4",
      city: "Town",
      state: "NY",
      zip: "10003",
    },
  ];

  const result = normalizeProperties(rawProperties, tenants);
  const propertyIds = result.normalizedProperties.map((property) => property.id);

  assert.equal(propertyIds.includes("prop-riverbend-annex"), true);
  assert.equal(result.tenantProperties.find((row) => row.tenant_id === 2).property_id, "prop-riverbend");
  assert.equal(result.unassignedTenantIds.includes(3), true);
  const missingProperty = result.normalizedProperties.find((property) => property.id === "missing-property");
  assert.equal(missingProperty.shipment_interval_days, 90);
  assert.deepEqual(missingProperty.tenant_ids, [3]);
});

test("exports split names and raw text ZIP codes", () => {
  const csv = toCsv([
    {
      tenant_id: 175236,
      property_id: "missing-property",
      batch_id: 1,
      first_name: "Kizzy",
      last_name: "O'Keefe",
      address1: "7781 Wilson Mountains",
      address2: "Apt. 269",
      city: "Port Zachariahshire",
      state: "OK",
      zip: "06323",
      shipment_date: "2026-04-24",
      minimum_next_shipment_date: "2026-07-23",
    },
  ]);

  const [header, row] = csv.trim().split("\n");
  assert.equal(
    header,
    "tenant_id,property_id,batch_id,first_name,last_name,address1,address2,city,state,zip,shipment_date,minimum_next_shipment_date",
  );
  assert.match(row, /,Kizzy,O'Keefe,/);
  assert.match(row, /,06323,/);
  assert.doesNotMatch(row, /'06323/);
});

test("normalizes filter sizes while preserving unusable values for review", () => {
  assert.deepEqual(parseSizeToken("20X20X1"), {
    raw_value: "20X20X1",
    normalized_value: "20x20x1",
    width_inches: 20,
    height_inches: 20,
    depth_inches: 1,
    parse_status: "parsed",
    parse_error: null,
  });

  assert.equal(parseSizeToken("25x16-1/2x1").normalized_value, "25x16.5x1");
  assert.equal(parseSizeToken("twenty-by-twenty").normalized_value, "20x20");
  assert.equal(parseSizeToken("one-hundred-by-twenty").normalized_value, "100x20");
  assert.equal(parseSizeToken("ninety-two-by-ten").normalized_value, "92x10");
  assert.equal(parseFilterSizes("14x20x1 20x20x1").length, 2);
  assert.equal(parseSizeToken("").parse_error, "No filter size provided");
  assert.equal(parseSizeToken("16-20x25x1").parse_status, "needs_review");
  assert.equal(parseSizeToken("20x").parse_error, "Missing required dimension");
});

test("matches imports confidently only when unit data is not conflicting", () => {
  const tenants = [
    {
      id: 1,
      first_name: "Kizzy",
      last_name: "O'Keefe",
      address1: "7781 Wilson Mountains",
      address2: "Apt. 269",
      city: "Port Zachariahshire",
      state: "OK",
      zip: "06323",
    },
  ];
  const indexes = buildTenantIndexes(tenants);

  assert.equal(normalizeZip("6323"), "06323");

  const confident = findMatch(
    {
      name: "Kizzy O'Keefe",
      address1: "7781 Wilson Mountains",
      address2: "Apt. 269",
      city: "Port Zachariahshire",
      state: "OK",
      zip: "6323",
    },
    indexes,
  );
  assert.equal(confident.matchStatus, "auto_matched");
  assert.equal(confident.matchedTenant.id, 1);

  const unitConflict = findMatch(
    {
      name: "Kizzy O'Keefe",
      address1: "7781 Wilson Mountains",
      address2: "Apt. 270",
      city: "Port Zachariahshire",
      state: "OK",
      zip: "06323",
    },
    indexes,
  );
  assert.equal(unitConflict.matchStatus, "needs_review");
  assert.equal(unitConflict.matchReason, "address2_conflict");
});

test("duplicate tenant identity candidates require review", () => {
  const tenants = [
    {
      id: 900001,
      first_name: "Casey",
      last_name: "Morgan",
      address1: "1188 Maple Loop",
      address2: "Apt. 4B",
      city: "Springfield",
      state: "IL",
      zip: "62704",
    },
    {
      id: 900002,
      first_name: "Casey",
      last_name: "Morgan",
      address1: "1188 Maple Loop",
      address2: "Apt. 4B",
      city: "Springfield",
      state: "IL",
      zip: "62704",
    },
  ];
  const indexes = buildTenantIndexes(tenants, new Set([900002]));
  const result = findMatch(
    {
      name: "Casey Morgan",
      address1: "1188 Maple Loop",
      address2: "Apt. 4B",
      city: "Springfield",
      state: "IL",
      zip: "62704",
    },
    indexes,
  );

  assert.equal(result.matchStatus, "needs_review");
  assert.equal(result.matchReason, "duplicate_tenant_identity");
  assert.equal(result.candidates.length, 2);
});
