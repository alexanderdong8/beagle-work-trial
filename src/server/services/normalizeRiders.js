"use strict";

/**
 * Rider labels arrive from the fixture as a Postgres-array-ish string, not as
 * normalized relational rows. Migration uses these helpers to derive
 * enrollments.normalized_rider_labels for audit/debugging.
 *
 * The raw riders string stays intact, and eligibility uses the same parser
 * directly because each enrollment has only a small rider list.
 */

function splitRiders(riders) {
  if (!riders) return [];

  let text = String(riders).trim();
  if (text.startsWith("{") && text.endsWith("}")) {
    text = text.slice(1, -1);
  }

  return text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part && part.toUpperCase() !== "NULL");
}

function normalizeRiderLabel(label) {
  // Normalize the label format before matching:
  // - lowercase;
  // - make "Airfilters" and "Air Filters" equivalent;
  // - drop prices/details in parentheses;
  // - remove punctuation;
  // - collapse whitespace.
  return String(label || "")
    .toLowerCase()
    .replace(/filters?\s+for\s+air/g, "air filters")
    .replace(/airfilters/g, "air filters")
    .replace(/air-filters/g, "air filters")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isAirFilterDeliveryRider(label) {
  const normalized = normalizeRiderLabel(label);
  const squashed = normalized.replace(/\s+/g, "");

  // Be explicit for the known fixture labels, then keep a small fallback for
  // harmless spelling/spacing variants that still clearly mean filter delivery.
  return (
    squashed === "airfiltersdelivery" ||
    squashed === "freeairfiltersdelivery" ||
    (/\bair\s*filters?\b/.test(normalized) && /\bdelivery\b/.test(normalized))
  );
}

function hasAirFilterDeliveryRider(riders) {
  return splitRiders(riders).some(isAirFilterDeliveryRider);
}

function normalizedRiderLabels(riders) {
  return splitRiders(riders).map(normalizeRiderLabel);
}

module.exports = {
  hasAirFilterDeliveryRider,
  isAirFilterDeliveryRider,
  normalizeRiderLabel,
  normalizedRiderLabels,
  splitRiders,
};
