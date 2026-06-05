import { Download, PackageCheck, RotateCcw } from "lucide-react";
import { useState } from "react";
import { apiPost } from "../api.js";
import { ErrorState } from "../components.jsx";

const DEFAULT_AS_OF = "2026-04-24";

export default function EligibilityPage() {
  // The UI intentionally starts with no batch results. The operator chooses a
  // date, clicks Ship Batch, and only then sees the persisted CSV download.
  const [asOf, setAsOf] = useState(DEFAULT_AS_OF);
  const [error, setError] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [batch, setBatch] = useState(null);
  const [resetResult, setResetResult] = useState(null);

  async function shipBatch() {
    // Ship Batch runs the full server-side eligibility/export flow. The client
    // does not calculate eligibility itself.
    setExporting(true);
    setError(null);
    setResetResult(null);

    try {
      const result = await apiPost("/api/exports", { asOf });
      setBatch(result.batch);
    } catch (err) {
      setError(err);
    } finally {
      setExporting(false);
    }
  }

  async function resetDemoState() {
    // Demo reset removes only export-created rows so the 4/24/26 flow can be
    // rerun without touching historical source data.
    setResetting(true);
    setError(null);
    setBatch(null);

    try {
      setResetResult(await apiPost("/api/reset-demo-state", {}));
    } catch (err) {
      setError(err);
    } finally {
      setResetting(false);
    }
  }

  return (
    <section className="batch-flow">
      <div className="panel batch-panel">
        <div className="batch-copy">
          <p className="eyebrow">Shipment Batch</p>
          <h2>Generate shipping CSV</h2>
        </div>
        <div className="control-row">
          <label>
            <span>As of</span>
            <input type="date" value={asOf} onChange={(event) => setAsOf(event.target.value)} />
          </label>
          <button className="icon-button" disabled={resetting} onClick={resetDemoState} type="button">
            <RotateCcw size={17} aria-hidden="true" />
            <span>{resetting ? "Resetting" : "Reset Demo"}</span>
          </button>
          <button className="primary-button" disabled={exporting} onClick={shipBatch} type="button">
            <PackageCheck size={17} aria-hidden="true" />
            <span>{exporting ? "Shipping" : "Ship Batch"}</span>
          </button>
        </div>
      </div>

      {error ? <ErrorState error={error} /> : null}

      {resetResult ? (
        <div className="notice notice-muted">
          Reset complete. Removed {resetResult.deleted_export_shipments} exported shipments and{" "}
          {resetResult.deleted_batches} export batches, plus {resetResult.deleted_import_shipments} imported shipments,{" "}
          {resetResult.deleted_import_rows} import rows, and {resetResult.deleted_filter_sizes} filter-size rows.
        </div>
      ) : null}

      {batch ? (
        <div className="panel batch-result">
          <div>
            <p className="eyebrow">Batch #{batch.id}</p>
            <h3>{batch.shipment_count} shipments created</h3>
          </div>
          <a className="primary-button download-button" href={`/api/exports/${batch.id}.csv`}>
            <Download size={17} aria-hidden="true" />
            <span>Download</span>
          </a>
        </div>
      ) : null}
    </section>
  );
}
