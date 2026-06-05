# Air Filter Shipment System

React + Express + SQLite app for the Corgi air-filter shipment work trial.

The app determines which tenants are eligible for air-filter shipments, exports a shipping CSV, records ordered shipments so they are not immediately exported again, and imports ShipStation-style CSV files for matching, review, tracking, and filter-size parsing.

For detailed schema decisions, data-quality findings, matching rules, cooldown tradeoffs, and implementation reasoning, see [implementation.md](implementation.md).

## Project Structure

- `src/server/`: Express API, SQLite migration, eligibility, export, import, matching, and normalization services.
- `src/client/`: Vite React app for Ship Batch and Import workflows.
- `fixtures/`: supplemental SQL and demo CSV files.
- `test/`: focused domain tests for eligibility helpers, CSV export, import matching, and filter-size parsing.
- `properties/properties.json`: provided property assignment/interval fixture.
- `properties/properties.normalized.json`: generated normalized property assignment artifact.
- `shipstation-export.csv`: provided ShipStation export fixture.
- `fixtures/matching-demo-shipstation.csv`: smaller demo CSV that exercises matching conflicts and flags.

## Run Locally

Install dependencies:

```bash
npm install
```

For the interview/demo flow, build the React app and start the Express server:

```bash
npm run build
npm start
```

Open:

```text
http://127.0.0.1:3001
```

You do not need to run migrations manually before every start. The server runs the migration/normalization step automatically when `npm start` starts the app. Run this manually only if you want to regenerate operational data immediately after changing schema or fixture files:

```bash
npm run migrate
```

For active development, use Vite plus the API server:

```bash
npm run dev
```

Then open the Vite client:

```text
http://127.0.0.1:5173
```

Use `npm start` when you want the simplest single-server demo. Use `npm run dev` when you are editing the React UI and want Vite's development refresh behavior.

## How To Use The App

### Ship Batch

1. Open the `Ship Batch` tab.
2. Leave the date as `2026-04-24`, or choose another date.
3. Click `Ship Batch`.
4. Click `Download` to save the generated CSV.
5. Click `Reset Demo` to clear demo-created export/import state and rerun the flow.

After shipping a batch, the same tenants/properties will not appear again immediately because export-created rows are stored as `ordered` shipments and count for cooldown.

### Import

1. Open the `Import` tab.
2. Choose a ShipStation-style CSV file.
3. Click `Import Selected CSV`.
4. Use `Matched Rows` to inspect automatic matches.
5. Use `Manual Review` to confirm a candidate tenant or `Reject and Dismiss` a row.
6. Use `Flags` to review missing, ambiguous, or unusable data.

Good files to try:

- `shipstation-export.csv`: the provided full fixture.
- `fixtures/matching-demo-shipstation.csv`: a smaller demo file with auto matches, address conflicts, missing fields, and filter-size flags.
