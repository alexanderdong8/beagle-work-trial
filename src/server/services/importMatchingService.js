"use strict";

/**
 * Build tenant indexes and score plausible matches for ShipStation import rows.
 */

const { normalizeAddressPart, normalizeText, tenantFullName } = require("../utils/strings");

function normalizeZip(value) {
  // ShipStation can emit short ZIPs like "1234"; pad to 5 for stable matching.
  const zip = String(value || "").trim();
  if (/^\d{1,4}$/.test(zip)) return zip.padStart(5, "0");
  return zip;
}

function addToIndex(index, key, tenant) {
  if (!key) return;
  if (!index.has(key)) index.set(key, []);
  index.get(key).push(tenant);
}

function buildTenantIndexes(tenants, duplicateTenantIds = new Set()) {
  const indexes = {
    byName: new Map(),
    byAddress1Zip: new Map(),
    byAddress1: new Map(),
    byAddress2: new Map(),
    byZip: new Map(),
  };

  for (const tenant of tenants) {
    // Precompute normalized fields once so candidate scoring avoids repeating
    // string normalization work for every import row.
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
    addToIndex(indexes.byAddress1Zip, `${indexedTenant.normalizedAddress1}|${indexedTenant.normalizedZip}`, indexedTenant);
    addToIndex(indexes.byAddress1, indexedTenant.normalizedAddress1, indexedTenant);
    addToIndex(indexes.byAddress2, indexedTenant.normalizedAddress2, indexedTenant);
    addToIndex(indexes.byZip, indexedTenant.normalizedZip, indexedTenant);
  }

  return indexes;
}

function normalizeImportRow(row) {
  // Apply the same normalization strategy used for tenant indexing.
  return {
    normalizedName: normalizeText(row.name),
    normalizedAddress1: normalizeAddressPart(row.address1),
    normalizedAddress2: normalizeAddressPart(row.address2),
    normalizedCity: normalizeAddressPart(row.city),
    normalizedState: normalizeAddressPart(row.state),
    normalizedZip: normalizeZip(row.zip),
  };
}

function scoreCandidate(row, candidate) {
  const normalized = normalizeImportRow(row);
  const matched = [];
  const conflicting = [];
  let score = 0;

  // Scores are intentionally additive: a candidate earns confidence from every
  // matching identity/address signal, then any important conflicts are surfaced
  // for manual review instead of silently ignored.
  if (candidate.normalizedName === normalized.normalizedName) {
    matched.push("Full name");
    score += 40;
  } else if (normalized.normalizedName) {
    conflicting.push("Full name");
  }

  if (candidate.normalizedAddress1 === normalized.normalizedAddress1) {
    matched.push("Address1");
    score += 25;
  } else if (normalized.normalizedAddress1) {
    conflicting.push("Address1");
  }

  if (candidate.normalizedAddress2 && normalized.normalizedAddress2 && candidate.normalizedAddress2 === normalized.normalizedAddress2) {
    matched.push("Address2");
    score += 10;
  } else if (candidate.normalizedAddress2 && normalized.normalizedAddress2 && candidate.normalizedAddress2 !== normalized.normalizedAddress2) {
    conflicting.push("Address2");
  }

  if (candidate.normalizedCity === normalized.normalizedCity) {
    matched.push("City");
    score += 7;
  } else if (normalized.normalizedCity) {
    conflicting.push("City");
  }

  if (candidate.normalizedState === normalized.normalizedState) {
    matched.push("State");
    score += 5;
  } else if (normalized.normalizedState) {
    conflicting.push("State");
  }

  if (candidate.normalizedZip === normalized.normalizedZip) {
    matched.push("ZIP");
    score += 13;
  } else if (normalized.normalizedZip) {
    conflicting.push("ZIP");
  }

  if (candidate.isDuplicateIdentity) conflicting.push("Duplicate identity");

  return {
    tenant: candidate,
    score,
    matchedFields: matched,
    conflictingFields: conflicting,
    hasAddress2Conflict: conflicting.includes("Address2"),
    isDuplicateIdentity: candidate.isDuplicateIdentity,
  };
}

function collectCandidateTenants(row, indexes) {
  const normalized = normalizeImportRow(row);
  const byId = new Map();
  const addAll = (tenants = []) => {
    for (const tenant of tenants) byId.set(tenant.id, tenant);
  };

  // Use indexes to gather plausible candidates instead of scanning every tenant
  // for every import row. Each gathered candidate is still scored independently.
  addAll(indexes.byName.get(normalized.normalizedName));
  addAll(indexes.byAddress1Zip.get(`${normalized.normalizedAddress1}|${normalized.normalizedZip}`));
  addAll(indexes.byAddress1.get(normalized.normalizedAddress1));
  addAll(indexes.byZip.get(normalized.normalizedZip));

  if (byId.size === 0) {
    addAll(indexes.byAddress2.get(normalized.normalizedAddress2));
  }

  return [...byId.values()];
}

function reasonForCandidate(candidate) {
  // These machine-readable reasons are surfaced in the review UI and flags API.
  if (!candidate) return "no_plausible_candidate";
  if (candidate.isDuplicateIdentity) return "duplicate_tenant_identity";
  if (candidate.hasAddress2Conflict) return "address2_conflict";
  if (candidate.score >= 95) return "confident_name_address_zip";
  if (candidate.score >= 90) return "unit_missing_needs_review";
  if (candidate.matchedFields.includes("Full name") && candidate.conflictingFields.includes("Address1")) {
    return "old_address_possible";
  }
  if (candidate.conflictingFields.length) return "field_conflict_needs_review";
  return "low_confidence_candidate";
}

function findMatch(row, indexes) {
  const candidates = collectCandidateTenants(row, indexes)
    .map((tenant) => scoreCandidate(row, tenant))
    .filter((candidate) => candidate.score >= 50)
    .sort((a, b) => b.score - a.score || a.tenant.id - b.tenant.id);

  const top = candidates[0] || null;
  const topTies = top ? candidates.filter((candidate) => candidate.score === top.score) : [];
  const hasDuplicateTie = topTies.length > 1 || topTies.some((candidate) => candidate.isDuplicateIdentity);
  // Auto-match is intentionally strict to reduce false positives:
  // high score, no tie, no address2 conflict, and not duplicate identity.
  const autoMatch =
    top &&
    top.score >= 95 &&
    topTies.length === 1 &&
    !top.hasAddress2Conflict &&
    !top.isDuplicateIdentity;

  return {
    candidates: candidates.slice(0, 5).map((candidate) => ({
      tenant_id: candidate.tenant.id,
      first_name: candidate.tenant.first_name,
      last_name: candidate.tenant.last_name,
      address1: candidate.tenant.address1,
      address2: candidate.tenant.address2,
      city: candidate.tenant.city,
      state: candidate.tenant.state,
      zip: candidate.tenant.zip,
      score: candidate.score,
      matched_fields: candidate.matchedFields,
      conflicting_fields: candidate.conflictingFields,
      reason: reasonForCandidate(candidate),
    })),
    matchedTenant: autoMatch ? top.tenant : null,
    matchStatus: autoMatch ? "auto_matched" : "needs_review",
    matchScore: top ? top.score : 0,
    matchReason: hasDuplicateTie ? "duplicate_tenant_identity" : reasonForCandidate(top),
    matchedFields: top ? top.matchedFields : [],
    conflictingFields: hasDuplicateTie ? [...new Set([...(top ? top.conflictingFields : []), "Duplicate identity"])] : top ? top.conflictingFields : [],
  };
}

module.exports = {
  buildTenantIndexes,
  findMatch,
  normalizeImportRow,
  normalizeZip,
  scoreCandidate,
};
