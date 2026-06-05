"use strict";

const path = require("path");
const Database = require("better-sqlite3");

const repoRoot = path.resolve(__dirname, "../..");
const dbPath = path.join(repoRoot, "database.db");

function openDb(options = {}) {
  // Keep connection creation centralized so every module uses the same sqlite
  // file and pragma defaults.
  const db = new Database(dbPath, options);
  if (!options.readonly) {
    // WAL improves concurrent read/write behavior for the API + UI workflow.
    db.pragma("journal_mode = WAL");
  }
  // Enforce declared foreign keys for all operational writes.
  db.pragma("foreign_keys = ON");
  return db;
}

module.exports = {
  dbPath,
  openDb,
  repoRoot,
};
