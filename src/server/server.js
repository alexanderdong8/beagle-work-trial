"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const { openDb, repoRoot } = require("./db");
const { migrate } = require("./migrate");
const { DEFAULT_AS_OF_DATE, getEligibility } = require("./services/eligibilityService");
const { createExportBatch, getBatchCsv, listBatches } = require("./services/exportService");
const { resetDemoState } = require("./services/resetService");

const PORT = process.env.PORT || 3001;

function withDb(handler) {
  return (req, res, next) => {
    const db = openDb();
    try {
      handler(req, res, db);
    } catch (error) {
      next(error);
    } finally {
      db.close();
    }
  };
}

function createApp() {
  migrate();

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "http://127.0.0.1:5173");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    next();
  });

  app.get(
    "/api/health",
    withDb((req, res, db) => {
      res.json({
        ok: true,
        tenants: db.prepare("SELECT COUNT(*) AS count FROM tenants").get().count,
      });
    }),
  );

  app.get(
    "/api/eligibility",
    withDb((req, res, db) => {
      res.json(getEligibility(db, { asOf: req.query.asOf || DEFAULT_AS_OF_DATE }));
    }),
  );

  app.post(
    "/api/exports",
    withDb((req, res, db) => {
      const result = createExportBatch(db, { asOf: req.body.asOf || DEFAULT_AS_OF_DATE });
      res.status(201).json({
        batch: result.batch,
        row_count: result.rows.length,
      });
    }),
  );

  app.get(
    "/api/exports",
    withDb((req, res, db) => {
      res.json({ batches: listBatches(db) });
    }),
  );

  app.get(
    "/api/exports/:id.csv",
    withDb((req, res, db) => {
      const result = getBatchCsv(db, Number(req.params.id));
      if (!result) {
        res.status(404).json({ error: "Export batch not found." });
        return;
      }

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${result.batch.csv_filename}"`);
      res.send(result.csv);
    }),
  );

  app.get(
    "/api/shipments",
    withDb((req, res, db) => {
      const rows = db
        .prepare(
          `
            SELECT s.*, t.first_name || ' ' || t.last_name AS recipient_name, p.name AS property_name
            FROM shipments s
            JOIN tenants t ON t.id = s.tenant_id
            JOIN properties p ON p.id = s.property_id
            ORDER BY s.shipment_date DESC, s.id DESC
            LIMIT 500
          `,
        )
        .all();
      res.json({ shipments: rows });
    }),
  );

  app.get(
    "/api/data-quality",
    withDb((req, res, db) => {
      const issues = db
        .prepare(
          `
            SELECT *
            FROM data_quality_issues
            ORDER BY issue_type, id
          `,
        )
        .all();

      const issueCounts = db
        .prepare(
          `
            SELECT issue_type, COUNT(*) AS count
            FROM data_quality_issues
            GROUP BY issue_type
            ORDER BY issue_type
          `,
        )
        .all();

      res.json({ issueCounts, issues });
    }),
  );

  app.post(
    "/api/reset-demo-state",
    withDb((req, res, db) => {
      const result = resetDemoState(db);
      res.json({
        ok: true,
        ...result,
      });
    }),
  );

  const distPath = path.join(repoRoot, "dist");
  const indexPath = path.join(distPath, "index.html");
  if (fs.existsSync(indexPath)) {
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(indexPath);
    });
  } else {
    app.get("/", (req, res) => {
      res
        .status(200)
        .send("React bundle not built yet. Run npm run dev for development or npm run build before npm start.");
    });
  }

  app.use((error, req, res, next) => {
    console.error(error);
    res.status(500).json({ error: error.message || "Unexpected server error." });
  });

  return app;
}

if (require.main === module) {
  createApp().listen(PORT, () => {
    console.log(`Air Filter Shipment System server listening on http://127.0.0.1:${PORT}`);
  });
}

module.exports = {
  createApp,
};
