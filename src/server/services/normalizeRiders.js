"use strict";

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
  return String(label || "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isAirFilterDeliveryRider(label) {
  const normalized = normalizeRiderLabel(label);
  const squashed = normalized.replace(/\s+/g, "");

  return (
    squashed === "freeairfiltersdelivery" ||
    squashed === "airfiltersdelivery" ||
    (squashed.includes("airfilter") && squashed.includes("delivery"))
  );
}

function hasAirFilterDeliveryRider(riders) {
  return splitRiders(riders).some(isAirFilterDeliveryRider);
}

module.exports = {
  hasAirFilterDeliveryRider,
  isAirFilterDeliveryRider,
  normalizeRiderLabel,
  splitRiders,
};
