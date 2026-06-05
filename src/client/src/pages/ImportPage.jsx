import { CheckCircle2, FileInput, RotateCcw, XCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiPost } from "../api.js";
import { ErrorState, LoadingState, Stat, StatusPill, TableShell } from "../components.jsx";

function FieldBadges({ fields = [], tone = "neutral" }) {
  return (
    <div className="badge-row">
      {fields.length ? fields.map((field) => <StatusPill key={field} tone={tone}>{field}</StatusPill>) : <span className="muted">None</span>}
    </div>
  );
}

function addressLine(row) {
  return [row.address1, row.address2, row.city, row.state, row.zip].filter(Boolean).join(", ");
}

function tenantAddress(row) {
  return [row.tenant_address1, row.tenant_address2, row.tenant_city, row.tenant_state, row.tenant_zip].filter(Boolean).join(", ");
}

function candidateAddress(candidate) {
  return [candidate.address1, candidate.address2, candidate.city, candidate.state, candidate.zip].filter(Boolean).join(", ");
}

function CandidateList({ rowId, onResolved }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busyTenantId, setBusyTenantId] = useState(null);

  useEffect(() => {
    let mounted = true;
    apiGet(`/api/import-rows/${rowId}/candidates`)
      .then((result) => {
        if (mounted) setData(result);
      })
      .catch((err) => {
        if (mounted) setError(err);
      });
    return () => {
      mounted = false;
    };
  }, [rowId]);

  async function confirm(tenantId) {
    setBusyTenantId(tenantId);
    try {
      await apiPost(`/api/import-rows/${rowId}/confirm`, { tenantId });
      await onResolved();
    } finally {
      setBusyTenantId(null);
    }
  }

  if (error) return <ErrorState error={error} />;
  if (!data) return <LoadingState label="Loading candidates" />;
  if (!data.candidates.length) return <div className="empty-state">No plausible tenant candidates found.</div>;

  return (
    <div className="candidate-list">
      {data.candidates.map((candidate) => (
        <div className="candidate-card" key={candidate.tenant_id}>
          <div>
            <strong>{candidate.first_name} {candidate.last_name}</strong>
            <small>Tenant #{candidate.tenant_id} · Confidence score {candidate.score}</small>
            <small>{candidateAddress(candidate)}</small>
          </div>
          <p className="mismatch-line">
            Not matching: {candidate.conflicting_fields.length ? candidate.conflicting_fields.join(", ") : "None"}
          </p>
          <button className="icon-button" disabled={busyTenantId === candidate.tenant_id} onClick={() => confirm(candidate.tenant_id)} type="button">
            <CheckCircle2 size={16} aria-hidden="true" />
            <span>Confirm Match</span>
          </button>
        </div>
      ))}
    </div>
  );
}

export default function ImportPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetResult, setResetResult] = useState(null);
  const [dismissingId, setDismissingId] = useState(null);
  const [resultTab, setResultTab] = useState("matched");
  const [selectedFile, setSelectedFile] = useState(null);
  const fileInputRef = useRef(null);

  const loadLatest = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      setData(await apiGet("/api/imports"));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadLatest();
  }, [loadLatest]);

  async function importFile() {
    if (!selectedFile) {
      setError(new Error("Choose a CSV file before importing."));
      return;
    }

    setImporting(true);
    setError(null);
    setResetResult(null);
    try {
      setData(await apiPost("/api/imports/shipstation", {
        filename: selectedFile.name,
        csvText: await selectedFile.text(),
      }));
    } catch (err) {
      setError(err);
    } finally {
      setImporting(false);
    }
  }

  async function resetDemoState() {
    setResetting(true);
    setError(null);
    try {
      const result = await apiPost("/api/reset-demo-state", {});
      setResetResult(result);
      await loadLatest();
    } catch (err) {
      setError(err);
    } finally {
      setResetting(false);
    }
  }

  async function dismiss(rowId) {
    setDismissingId(rowId);
    try {
      await apiPost(`/api/import-rows/${rowId}/dismiss`, {});
      await loadLatest();
    } finally {
      setDismissingId(null);
    }
  }

  if (loading && !data) return <LoadingState label="Loading import workspace" />;

  return (
    <section className="import-flow">
      <div className="panel batch-panel">
        <div className="batch-copy">
          <p className="eyebrow">ShipStation Import</p>
          <h2>Match shipments and review flags</h2>
        </div>
        <div className="control-row">
          <label className="file-picker">
            <span>CSV file</span>
            <input
              accept=".csv,text/csv"
              className="visually-hidden"
              onChange={(event) => setSelectedFile(event.target.files?.[0] || null)}
              ref={fileInputRef}
              type="file"
            />
            <div className="file-picker-control">
              <button className="icon-button" onClick={() => fileInputRef.current?.click()} type="button">
                <FileInput size={16} aria-hidden="true" />
                <span>Choose CSV</span>
              </button>
              <span className={selectedFile ? "file-name" : "file-name file-name-empty"}>
                {selectedFile ? selectedFile.name : "No file selected"}
              </span>
            </div>
          </label>
          <button className="icon-button" disabled={resetting} onClick={resetDemoState} type="button">
            <RotateCcw size={17} aria-hidden="true" />
            <span>{resetting ? "Resetting" : "Reset Demo"}</span>
          </button>
          <button className="primary-button" disabled={importing || !selectedFile} onClick={importFile} type="button">
            <FileInput size={17} aria-hidden="true" />
            <span>{importing ? "Importing" : "Import Selected CSV"}</span>
          </button>
        </div>
      </div>

      {error ? <ErrorState error={error} /> : null}

      {resetResult ? (
        <div className="notice notice-muted">
          Reset complete.
        </div>
      ) : null}

      {!data?.batch ? (
        <div className="empty-state">No import has been run yet.</div>
      ) : (
        <>
          <div className="stats-row import-stats">
            <Stat label="Total rows" value={data.batch.total_rows} />
            <Stat label="Auto matched" value={data.batch.auto_matched_rows} />
            <Stat label="Needs review" value={data.batch.review_rows} />
            <Stat label="Flags" value={data.flags.length} />
          </div>

          <section className="panel import-results">
            <div className="section-heading">
              <h3>Import Results</h3>
              <div className="subtabs" aria-label="Import result sections">
                <button
                  className={`subtab ${resultTab === "matched" ? "subtab-active" : ""}`}
                  onClick={() => setResultTab("matched")}
                  type="button"
                >
                  <span>Matched Rows</span>
                  <StatusPill tone="good">{data.matchedRows.length}</StatusPill>
                </button>
                <button
                  className={`subtab ${resultTab === "review" ? "subtab-active" : ""}`}
                  onClick={() => setResultTab("review")}
                  type="button"
                >
                  <span>Manual Review</span>
                  <StatusPill tone="warn">{data.reviewRows.length}</StatusPill>
                </button>
                <button
                  className={`subtab ${resultTab === "flags" ? "subtab-active" : ""}`}
                  onClick={() => setResultTab("flags")}
                  type="button"
                >
                  <span>Flags</span>
                  <StatusPill tone="warn">{data.flags.length}</StatusPill>
                </button>
              </div>
            </div>

            {resultTab === "matched" ? (
              <TableShell>
                <table>
                  <thead>
                    <tr>
                      <th>Shipment</th>
                      <th>Raw Recipient</th>
                      <th>Matched Tenant</th>
                      <th>Confidence Score</th>
                      <th>Matched Fields</th>
                      <th>Shipment</th>
                      <th>Sizes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.matchedRows.map((row) => (
                      <tr key={row.id}>
                        <td>{row.shipment_id}<small>{row.ship_date}</small></td>
                        <td>{row.raw_name}<small>{addressLine(row)}</small></td>
                        <td>{row.matched_tenant_id}<small>{row.first_name} {row.last_name}</small><small>{tenantAddress(row)}</small></td>
                        <td>{row.match_score}</td>
                        <td><FieldBadges fields={row.matched_fields} tone="good" /></td>
                        <td><StatusPill tone="good">{row.shipment_status || "shipped"}</StatusPill></td>
                        <td>{row.filter_sizes.map((size) => size.normalized_value || size.raw_value || "Needs review").join(", ")}</td>
                      </tr>
                    ))}
                    {!data.matchedRows.length ? (
                      <tr>
                        <td colSpan="7">No rows matched automatically.</td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </TableShell>
            ) : null}

            {resultTab === "review" ? (
              <div className="review-list">
                {data.reviewRows.length ? data.reviewRows.map((row) => (
                  <article className="review-card" key={row.id}>
                    <div className="raw-row">
                      <h3>{row.raw_name}</h3>
                      <p>{addressLine(row)}</p>
                      <p className="mismatch-line">
                        Not matching: {row.conflicting_fields.length ? row.conflicting_fields.join(", ") : row.match_reason}
                      </p>
                      <button className="icon-button" disabled={dismissingId === row.id} onClick={() => dismiss(row.id)} type="button">
                        <XCircle size={16} aria-hidden="true" />
                        <span>Reject and Dismiss</span>
                      </button>
                    </div>
                    <CandidateList rowId={row.id} onResolved={loadLatest} />
                  </article>
                )) : (
                  <div className="empty-state">No rows need manual matching.</div>
                )}
              </div>
            ) : null}

            {resultTab === "flags" ? (
              <TableShell>
                <table>
                  <thead>
                    <tr>
                      <th>Import Row</th>
                      <th>Recipient</th>
                      <th>Issue</th>
                      <th>Raw Value</th>
                      <th>Follow-up</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.flags.map((flag, index) => (
                      <tr key={`${flag.import_row_id}-${flag.issue_type}-${index}`}>
                        <td>#{flag.import_row_id}<small>{flag.shipment_id}</small></td>
                        <td>{flag.raw_recipient}</td>
                        <td>{flag.explanation || flag.issue_type}</td>
                        <td>{flag.raw_value || "Blank"}</td>
                        <td>{flag.follow_up}</td>
                      </tr>
                    ))}
                    {!data.flags.length ? (
                      <tr>
                        <td colSpan="5">No flags need follow-up.</td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </TableShell>
            ) : null}
          </section>
        </>
      )}
    </section>
  );
}
