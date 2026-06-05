# Air Filter Shipment System

React + Express + SQLite app for the Corgi air-filter shipment work trial.

The app determines which tenants are eligible for air-filter shipments, exports a shipping CSV, records ordered shipments so they are not immediately exported again, and imports ShipStation-style CSV files for matching, review, tracking, and filter-size parsing.

For detailed schema decisions, data-quality findings, matching rules, cooldown tradeoffs, and implementation reasoning, see [implementation.md](implementation.md).

## Project Structure

- `src/server/`: Express API, SQLite migration, eligibility, export, import, matching, and normalization services.
- `src/client/`: Vite React app for Ship Batch and Import workflows.
- `fixtures/`: supplemental SQL and demo CSV files.
- `test/`: focused domain tests for eligibility helpers, CSV export, import matching, and filter-size parsing.
- `properties.json`: provided property assignment/interval fixture.
- `properties.normalized.json`: generated normalized property assignment artifact.
- `shipstation-export.csv`: provided ShipStation export fixture.
- `fixtures/matching-demo-shipstation.csv`: smaller demo CSV that exercises matching conflicts and flags.

## Run Locally

Install dependencies:

```bash
npm install
```

Run migration:

```bash
npm run migrate
```

Start the app:

```bash
npm start
```

Open:

```text
http://127.0.0.1:3001
```

For development with Vite and the API server:

```bash
npm run dev
```

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

## Useful Commands

```bash
npm test
npm run build
npm run migrate
```
