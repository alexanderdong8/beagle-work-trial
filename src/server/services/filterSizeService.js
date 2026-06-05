"use strict";

/**
 * Parse ShipStation filter-size tokens into raw, normalized, and numeric forms.
 *
 * Bad size data is stored with a parse error instead of failing the import.
 */

const WORD_NUMBERS = new Map([
  ["zero", 0],
  ["one", 1],
  ["two", 2],
  ["three", 3],
  ["four", 4],
  ["five", 5],
  ["six", 6],
  ["seven", 7],
  ["eight", 8],
  ["nine", 9],
  ["ten", 10],
  ["eleven", 11],
  ["twelve", 12],
  ["thirteen", 13],
  ["fourteen", 14],
  ["fifteen", 15],
  ["sixteen", 16],
  ["seventeen", 17],
  ["eighteen", 18],
  ["nineteen", 19],
  ["twenty", 20],
  ["thirty", 30],
  ["forty", 40],
  ["fifty", 50],
  ["sixty", 60],
  ["seventy", 70],
  ["eighty", 80],
  ["ninety", 90],
]);

function formatNumber(value) {
  return Number.isInteger(value) ? String(value) : String(value).replace(/0+$/, "").replace(/\.$/, "");
}

function parseWordNumber(token) {
  const parts = String(token || "")
    .toLowerCase()
    .replace(/-/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return null;

  // Minimal English number parsing for size dimensions:
  // - supports "twenty five", "ninety-two", "one hundred", "one-hundred-twenty"
  // - supports optional "and"
  // - supports "thousand" (not expected for filters, but keeps logic general)
  let total = 0;
  let current = 0;

  for (const part of parts) {
    if (part === "and") continue;

    if (WORD_NUMBERS.has(part)) {
      current += WORD_NUMBERS.get(part);
      continue;
    }

    if (part === "hundred") {
      current = (current || 1) * 100;
      continue;
    }

    if (part === "thousand") {
      total += (current || 1) * 1000;
      current = 0;
      continue;
    }

    return null;
  }

  return total + current;
}

function parseDimension(token) {
  const value = String(token || "").trim().toLowerCase();
  if (!value) return { ok: false, error: "Missing required dimension" };

  const wordNumber = parseWordNumber(value);
  if (wordNumber != null) return { ok: true, value: wordNumber };

  const plain = value.match(/^(\d+(?:\.\d+)?)$/);
  if (plain) return { ok: true, value: Number(plain[1]) };

  const fraction = value.match(/^(\d+)\/(\d+)$/);
  if (fraction) {
    const denominator = Number(fraction[2]);
    if (denominator === 0) return { ok: false, error: "Fraction denominator cannot be zero" };
    return { ok: true, value: Number(fraction[1]) / denominator };
  }

  const mixedFraction = value.match(/^(\d+)-(\d+)\/(\d+)$/);
  if (mixedFraction) {
    const denominator = Number(mixedFraction[3]);
    if (denominator === 0) return { ok: false, error: "Fraction denominator cannot be zero" };
    return {
      ok: true,
      value: Number(mixedFraction[1]) + Number(mixedFraction[2]) / denominator,
    };
  }

  if (/^\d+-\d+$/.test(value)) {
    return { ok: false, error: "Dimension appears to contain a range or ambiguous hyphen" };
  }

  return {
    ok: false,
    error: /^[a-z-]+$/.test(value) ? "Unsupported word-based dimension" : "Malformed size dimension",
  };
}

function parseSizeToken(rawToken) {
  const raw = String(rawToken || "").trim();
  if (!raw) {
    return {
      raw_value: "",
      normalized_value: null,
      width_inches: null,
      height_inches: null,
      depth_inches: null,
      parse_status: "needs_review",
      parse_error: "No filter size provided",
    };
  }

  const normalizedSeparator = raw
    .toLowerCase()
    .replace(/×/g, "x")
    .replace(/-by-/g, "x")
    .replace(/\s+by\s+/g, "x");
  const parts = normalizedSeparator.split("x");

  if (parts.length < 2 || parts.length > 3 || parts.some((part) => part === "")) {
    return {
      raw_value: raw,
      normalized_value: null,
      width_inches: null,
      height_inches: null,
      depth_inches: null,
      parse_status: "needs_review",
      parse_error: parts.length <= 2 ? "Missing required dimension" : "Expected 2 or 3 dimensions",
    };
  }

  const parsed = parts.map(parseDimension);
  const failed = parsed.find((part) => !part.ok);
  if (failed) {
    return {
      raw_value: raw,
      normalized_value: null,
      width_inches: null,
      height_inches: null,
      depth_inches: null,
      parse_status: "needs_review",
      parse_error: failed.error,
    };
  }

  const numbers = parsed.map((part) => part.value);
  return {
    raw_value: raw,
    normalized_value: numbers.map(formatNumber).join("x"),
    width_inches: numbers[0],
    height_inches: numbers[1],
    depth_inches: numbers[2] ?? null,
    parse_status: "parsed",
    parse_error: null,
  };
}

function parseFilterSizes(customFieldValue) {
  const value = String(customFieldValue || "").trim();
  if (!value) return [parseSizeToken("")];
  return value.split(/\s+/).filter(Boolean).map(parseSizeToken);
}

module.exports = {
  parseDimension,
  parseFilterSizes,
  parseSizeToken,
};
