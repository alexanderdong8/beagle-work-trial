"use strict";

const path = require("path");
const Database = require("better-sqlite3");

const repoRoot = path.resolve(__dirname, "../..");
const dbPath = path.join(repoRoot, "database.db");

function openDb(options = {}) {
  const db = new Database(dbPath, options);
  if (!options.readonly) {
    db.pragma("journal_mode = WAL");
  }
  db.pragma("foreign_keys = ON");
  return db;
}

module.exports = {
  dbPath,
  openDb,
  repoRoot,
};
