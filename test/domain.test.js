"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { daysBetween } = require("../src/server/utils/dates");
const { hasAirFilterDeliveryRider } = require("../src/server/services/normalizeRiders");
const { normalizeProperties } = require("../src/server/services/normalizeProperties");
const { toCsv } = require("../src/server/services/exportService");

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

test("normalizes duplicate property ids, duplicate tenant assignments, and fallback tenants", () => {
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
  assert.equal(
    result.normalizedProperties.find((property) => property.id.startsWith("fallback-3-main")).shipment_interval_days,
    90,
  );
});

test("exports split names and raw text ZIP codes", () => {
  const csv = toCsv([
    {
      tenant_id: 175236,
      property_id: "fallback-7781-wilson-mountains",
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
