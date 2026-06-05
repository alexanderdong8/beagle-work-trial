"use strict";

// Shared formatting/normalization helpers for fixture cleanup, export rows, and
// CSV generation.

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeText(value) {
  return normalizeWhitespace(value).toLowerCase();
}

function normalizeAddressPart(value) {
  return normalizeText(value).replace(/[^\w\s-]/g, "").replace(/\s+/g, " ").trim();
}

function tenantFullName(tenant) {
  return normalizeWhitespace(`${tenant.first_name || ""} ${tenant.last_name || ""}`);
}

function csvEscape(value) {
  const text = value == null ? "" : String(value);
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

module.exports = {
  csvEscape,
  normalizeAddressPart,
  normalizeText,
  normalizeWhitespace,
  tenantFullName,
};
