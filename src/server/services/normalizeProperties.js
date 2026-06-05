"use strict";

/**
 * Property normalization.
 *
 * The source JSON is intentionally messy. This module turns it into deterministic
 * operational data while preserving a record of every issue and resolution.
 */

const fs = require("fs");
const path = require("path");
const { repoRoot } = require("../db");
const {
  normalizeAddressPart,
  normalizeText,
  propertyIdFromAddress,
  tenantFullName,
} = require("../utils/strings");

const DEFAULT_FALLBACK_INTERVAL_DAYS = 90;

function slugify(value) {
  return normalizeText(value)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizedDuplicatePropertyId(rawId, property, usedIds) {
  // Prefer a readable name-based id for Riverbend Annex over an opaque suffix.
  const nameSlug = slugify(property.name);
  const candidate = nameSlug && nameSlug !== slugify(rawId) ? `prop-${nameSlug}` : `${rawId}-2`;

  if (!usedIds.has(candidate)) return candidate;

  let suffix = 2;
  while (usedIds.has(`${candidate}-${suffix}`)) suffix += 1;
  return `${candidate}-${suffix}`;
}

function tenantIdentityKey(tenant) {
  // Full identity duplicate detection uses name plus address. That catches the
  // Casey Morgan fixture without merging people who merely share a last name.
  return [
    tenant.first_name,
    tenant.last_name,
    tenant.address1,
    tenant.address2,
    tenant.city,
    tenant.state,
    tenant.zip,
  ]
    .map(normalizeAddressPart)
    .join("|");
}

function normalizeProperties(rawProperties, tenants) {
  // First pass: normalize the supplied property groups and apply "first tenant
  // assignment wins" for tenants listed in more than one property.
  const normalizedProperties = [];
  const tenantProperties = [];
  const dataQualityIssues = [];
  const usedPropertyIds = new Set();
  const tenantToProperty = new Map();
  const dbTenantIds = new Set(tenants.map((tenant) => tenant.id));

  for (const property of rawProperties) {
    const rawId = property.id;
    let normalizedId = rawId;

    if (usedPropertyIds.has(rawId)) {
      normalizedId = normalizedDuplicatePropertyId(rawId, property, usedPropertyIds);
      dataQualityIssues.push({
        issue_type: "duplicate_property_id",
        property_id: rawId,
        related_property_id: normalizedId,
        details: `Property id "${rawId}" appeared more than once. Duplicate name: ${property.name}.`,
        resolution: `Created distinct normalized property id "${normalizedId}" so the different interval is preserved.`,
      });
    }

    usedPropertyIds.add(normalizedId);
    normalizedProperties.push({
      id: normalizedId,
      name: property.name,
      shipment_interval_days: property.shipment_interval_days,
      tenant_ids: [],
    });

    for (const tenantId of property.tenant_ids || []) {
      if (!dbTenantIds.has(tenantId)) {
        dataQualityIssues.push({
          issue_type: "property_tenant_missing_from_database",
          tenant_id: tenantId,
          property_id: normalizedId,
          details: `Tenant id ${tenantId} was listed in ${normalizedId}, but does not exist in tenants.`,
          resolution: "Ignored this assignment because the tenant row is missing.",
        });
        continue;
      }

      if (tenantToProperty.has(tenantId)) {
        dataQualityIssues.push({
          issue_type: "duplicate_tenant_assignment",
          tenant_id: tenantId,
          property_id: tenantToProperty.get(tenantId),
          related_property_id: normalizedId,
          details: `Tenant ${tenantId} appeared in multiple property groups.`,
          resolution: `Kept first assignment (${tenantToProperty.get(tenantId)}) and ignored later assignment (${normalizedId}).`,
        });
        continue;
      }

      tenantToProperty.set(tenantId, normalizedId);
      tenantProperties.push({
        tenant_id: tenantId,
        property_id: normalizedId,
        assignment_source: "properties_json",
        notes: null,
      });

      normalizedProperties[normalizedProperties.length - 1].tenant_ids.push(tenantId);
    }
  }

  const fallbackPropertiesById = new Map();
  const unassignedTenantIds = [];

  // Second pass: every tenant needs an operational property assignment. Missing
  // JSON assignments receive deterministic address-based fallback properties.
  for (const tenant of tenants) {
    if (tenantToProperty.has(tenant.id)) continue;

    const fallbackPropertyId = propertyIdFromAddress(tenant);
    unassignedTenantIds.push(tenant.id);

    if (!fallbackPropertiesById.has(fallbackPropertyId)) {
      fallbackPropertiesById.set(fallbackPropertyId, {
        id: fallbackPropertyId,
        name: `Fallback: ${tenant.address1 || tenantFullName(tenant)}`,
        shipment_interval_days: DEFAULT_FALLBACK_INTERVAL_DAYS,
        tenant_ids: [],
      });
    }

    fallbackPropertiesById.get(fallbackPropertyId).tenant_ids.push(tenant.id);
    tenantProperties.push({
      tenant_id: tenant.id,
      property_id: fallbackPropertyId,
      assignment_source: "fallback_address",
      notes: "Tenant was not present in properties.json; assigned address-based fallback property with 90-day interval.",
    });

    dataQualityIssues.push({
      issue_type: "tenant_missing_from_properties_json",
      tenant_id: tenant.id,
      property_id: fallbackPropertyId,
      details: `Tenant ${tenant.id} (${tenantFullName(tenant)}) was not assigned to a property in properties.json.`,
      resolution: `Assigned address-based fallback property ${fallbackPropertyId} with ${DEFAULT_FALLBACK_INTERVAL_DAYS}-day interval.`,
    });
  }

  normalizedProperties.push(...fallbackPropertiesById.values());

  const identityGroups = new Map();
  // Third pass: identify duplicate active tenant identities so exports operate
  // on canonical rows without deleting raw fixture data.
  for (const tenant of tenants) {
    const key = tenantIdentityKey(tenant);
    if (!identityGroups.has(key)) identityGroups.set(key, []);
    identityGroups.get(key).push(tenant);
  }

  const duplicateTenantIds = new Set();
  for (const group of identityGroups.values()) {
    if (group.length <= 1) continue;

    const sorted = [...group].sort((a, b) => a.id - b.id);
    const canonical = sorted[0];
    for (const duplicate of sorted.slice(1)) {
      duplicateTenantIds.add(duplicate.id);
      dataQualityIssues.push({
        issue_type: "duplicate_tenant_identity",
        tenant_id: canonical.id,
        related_tenant_id: duplicate.id,
        details: `Duplicate tenant identity found for ${tenantFullName(canonical)} at ${canonical.address1}, ${canonical.city}.`,
        resolution: `Kept tenant ${canonical.id} as canonical and excluded duplicate tenant ${duplicate.id} from operational eligibility/export.`,
      });
    }
  }

  return {
    duplicateTenantIds: [...duplicateTenantIds],
    normalizedProperties,
    tenantProperties,
    dataQualityIssues,
    unassignedTenantIds,
  };
}

function loadRawProperties() {
  const filePath = path.join(repoRoot, "properties.json");
  return JSON.parse(fs.readFileSync(filePath, "utf8")).properties;
}

function writeNormalizedPropertiesFile(result) {
  // Write the normalized artifact as a reviewable audit file next to the raw
  // properties.json. The app loads database tables, not this file directly.
  const filePath = path.join(repoRoot, "properties.normalized.json");
  const payload = {
    version: 1,
    description: "Normalized property shipment intervals and tenant assignments generated from properties.json.",
    default_fallback_interval_days: DEFAULT_FALLBACK_INTERVAL_DAYS,
    properties: result.normalizedProperties.map((property) => ({
      id: property.id,
      name: property.name,
      shipment_interval_days: property.shipment_interval_days,
      tenant_ids: property.tenant_ids,
    })),
    unassigned_tenant_ids: result.unassignedTenantIds,
    duplicate_tenant_ids_excluded_from_export: result.duplicateTenantIds,
  };

  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
  return filePath;
}

module.exports = {
  DEFAULT_FALLBACK_INTERVAL_DAYS,
  loadRawProperties,
  normalizeProperties,
  writeNormalizedPropertiesFile,
};
