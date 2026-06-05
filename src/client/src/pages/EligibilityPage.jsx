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
  const [csv, setCsv] = useState("");
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
      setCsv(result.csv);
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
    setCsv("");

    try {
      setResetResult(await apiPost("/api/reset-demo-state", {}));
    } catch (err) {
      setError(err);
    } finally {
      setResetting(false);
    }
  }

  function downloadCsv() {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = batch?.csv_filename || `shipments-${asOf}.csv`;
    link.click();
    URL.revokeObjectURL(url);
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
          {resetResult.deleted_import_shipments} imported shipments, plus {resetResult.deleted_import_rows} import rows.
        </div>
      ) : null}

      {batch ? (
        <div className="panel batch-result">
          <div>
            <p className="eyebrow">{batch.as_of_date}</p>
            <h3>{batch.shipment_count} shipments created</h3>
          </div>
          <button className="primary-button download-button" onClick={downloadCsv} type="button">
            <Download size={17} aria-hidden="true" />
            <span>Download</span>
          </button>
        </div>
      ) : null}
    </section>
  );
}
