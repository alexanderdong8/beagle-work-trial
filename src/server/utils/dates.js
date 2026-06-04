"use strict";

const MS_PER_DAY = 86_400_000;

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || "");
}

function parseIsoDate(value) {
  if (!isIsoDate(value)) {
    throw new Error(`Expected date in YYYY-MM-DD format, received: ${value}`);
  }

  const [year, month, day] = value.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

function daysBetween(startDate, endDate) {
  return Math.floor((parseIsoDate(endDate) - parseIsoDate(startDate)) / MS_PER_DAY);
}

function addDays(date, days) {
  const utc = parseIsoDate(date) + days * MS_PER_DAY;
  return new Date(utc).toISOString().slice(0, 10);
}

function toIsoDate(value) {
  if (!value) return null;
  if (isIsoDate(value)) return value;

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Could not parse date: ${value}`);
  }
  return parsed.toISOString().slice(0, 10);
}

module.exports = {
  addDays,
  daysBetween,
  isIsoDate,
  toIsoDate,
};
