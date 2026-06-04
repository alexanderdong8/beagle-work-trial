"use strict";

const { daysBetween, isIsoDate } = require("../utils/dates");
const { tenantFullName } = require("../utils/strings");
const { hasAirFilterDeliveryRider } = require("./normalizeRiders");

const DEFAULT_AS_OF_DATE = "2026-04-24";
const COOLDOWN_STATUSES = ["historical", "ordered", "shipped", "delivered", "confirmed"];

function assertAsOfDate(asOf = DEFAULT_AS_OF_DATE) {
  if (!isIsoDate(asOf)) {
    throw new Error("asOf must be provided in YYYY-MM-DD format.");
  }
  return asOf;
}

function buildMap(rows, keyField, valueFactory) {
  const map = new Map();
  for (const row of rows) {
    map.set(row[keyField], valueFactory(row));
  }
  return map;
}

function getDuplicateTenantIds(db) {
  return new Set(
    db
      .prepare(
        `
          SELECT related_tenant_id
          FROM data_quality_issues
          WHERE issue_type = 'duplicate_tenant_identity'
            AND related_tenant_id IS NOT NULL
        `,
      )
      .pluck()
      .all(),
  );
}

function getEnrollmentQualifiedTenantIds(db) {
  const rows = db
    .prepare(
      `
        SELECT tenant_id, riders
        FROM enrollments
        WHERE active = 1
          AND product = 'Renters Kit'
        ORDER BY tenant_id
      `,
    )
    .all();

  const qualified = new Set();
  for (const row of rows) {
    if (hasAirFilterDeliveryRider(row.riders)) {
      qualified.add(row.tenant_id);
    }
  }
  return qualified;
}

function getLookupMaps(db, asOf) {
  const assignments = db
    .prepare(
      `
        SELECT tenant_id, property_id
        FROM tenant_properties
      `,
    )
    .all();

  const properties = db
    .prepare(
      `
        SELECT id, name, shipment_interval_days, source
        FROM properties
        ORDER BY id
      `,
    )
    .all();

  const latestShipments = db
    .prepare(
      `
        SELECT property_id, MAX(shipment_date) AS last_shipment_date
        FROM shipments
        WHERE shipment_date <= @asOf
          AND status IN (${COOLDOWN_STATUSES.map((status) => `'${status}'`).join(", ")})
        GROUP BY property_id
      `,
    )
    .all({ asOf });

  return {
    propertyIntervals: buildMap(properties, "id", (row) => row.shipment_interval_days),
    propertyLastShipmentDate: buildMap(latestShipments, "property_id", (row) => row.last_shipment_date),
    propertyLookup: buildMap(properties, "id", (row) => row),
    tenantToProperty: buildMap(assignments, "tenant_id", (row) => row.property_id),
  };
}

function formatTenantRow(tenant, property, extra = {}) {
  return {
    tenant_id: tenant.id,
    recipient_name: tenantFullName(tenant),
    address1: tenant.address1,
    address2: tenant.address2,
    city: tenant.city,
    state: tenant.state,
    zip: tenant.zip,
    property_id: property ? property.id : null,
    property_name: property ? property.name : null,
    shipment_interval_days: property ? property.shipment_interval_days : null,
    ...extra,
  };
}

function getEligibility(db, options = {}) {
  const asOf = assertAsOfDate(options.asOf || DEFAULT_AS_OF_DATE);
  const tenants = db.prepare("SELECT * FROM tenants ORDER BY id ASC").all();
  const enrollmentQualifiedTenantIds = getEnrollmentQualifiedTenantIds(db);
  const duplicateTenantIds = getDuplicateTenantIds(db);
  const {
    propertyIntervals,
    propertyLastShipmentDate,
    propertyLookup,
    tenantToProperty,
  } = getLookupMaps(db, asOf);

  const selectedPropertyIds = new Set();
  const eligible = [];
  const excluded = [];
  const cooldownByProperty = [];

  for (const [propertyId, property] of propertyLookup) {
    const lastShipmentDate = propertyLastShipmentDate.get(propertyId) || null;
    const interval = propertyIntervals.get(propertyId);
    cooldownByProperty.push({
      property_id: propertyId,
      property_name: property.name,
      shipment_interval_days: interval,
      last_shipment_date: lastShipmentDate,
      days_since_last_shipment: lastShipmentDate ? daysBetween(lastShipmentDate, asOf) : null,
      cooldown_active: lastShipmentDate ? daysBetween(lastShipmentDate, asOf) < interval : false,
    });
  }

  for (const tenant of tenants) {
    const propertyId = tenantToProperty.get(tenant.id);
    const property = propertyLookup.get(propertyId);

    if (duplicateTenantIds.has(tenant.id)) {
      excluded.push(
        formatTenantRow(tenant, property, {
          reason: "duplicate_tenant_identity",
          explanation: "Duplicate tenant identity excluded from operational export; canonical tenant remains eligible if otherwise qualified.",
        }),
      );
      continue;
    }

    if (!enrollmentQualifiedTenantIds.has(tenant.id)) {
      excluded.push(
        formatTenantRow(tenant, property, {
          reason: "no_qualifying_enrollment",
          explanation: "Tenant does not have an active Renters Kit enrollment with an air-filter delivery rider.",
        }),
      );
      continue;
    }

    if (!propertyId || !property) {
      excluded.push(
        formatTenantRow(tenant, property, {
          reason: "missing_property_assignment",
          explanation: "Tenant does not have an operational property assignment.",
        }),
      );
      continue;
    }

    const interval = propertyIntervals.get(propertyId);
    const lastShipmentDate = propertyLastShipmentDate.get(propertyId) || null;
    const daysSinceLastShipment = lastShipmentDate ? daysBetween(lastShipmentDate, asOf) : null;
    const cooldownExpired = !lastShipmentDate || daysSinceLastShipment >= interval;

    if (!cooldownExpired) {
      excluded.push(
        formatTenantRow(tenant, property, {
          reason: "property_cooldown_active",
          explanation: `Property last had a shipment/order ${daysSinceLastShipment} days before ${asOf}; interval is ${interval} days.`,
          last_shipment_date: lastShipmentDate,
          days_since_last_shipment: daysSinceLastShipment,
        }),
      );
      continue;
    }

    if (selectedPropertyIds.has(propertyId)) {
      excluded.push(
        formatTenantRow(tenant, property, {
          reason: "same_property_already_selected",
          explanation: "Another eligible tenant in this property was already selected for this batch.",
          last_shipment_date: lastShipmentDate,
          days_since_last_shipment: daysSinceLastShipment,
        }),
      );
      continue;
    }

    eligible.push(
      formatTenantRow(tenant, property, {
        reason: lastShipmentDate ? "cooldown_expired" : "no_prior_property_shipment",
        explanation: lastShipmentDate
          ? `Property cooldown expired: ${daysSinceLastShipment} days since latest shipment/order.`
          : "No prior shipment/order exists for this property.",
        last_shipment_date: lastShipmentDate,
        days_since_last_shipment: daysSinceLastShipment,
      }),
    );
    selectedPropertyIds.add(propertyId);
  }

  return {
    asOf,
    summary: {
      eligible_count: eligible.length,
      excluded_count: excluded.length,
      enrollment_qualified_count: enrollmentQualifiedTenantIds.size,
      duplicate_tenant_count: duplicateTenantIds.size,
      property_count: propertyLookup.size,
    },
    eligible,
    excluded,
    cooldownByProperty: cooldownByProperty.sort((a, b) => a.property_id.localeCompare(b.property_id)),
  };
}

module.exports = {
  COOLDOWN_STATUSES,
  DEFAULT_AS_OF_DATE,
  getEligibility,
};
