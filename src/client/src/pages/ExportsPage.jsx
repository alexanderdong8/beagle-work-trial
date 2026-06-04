import { FileDown, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { apiGet } from "../api.js";
import { ErrorState, LoadingState, StatusPill, TableShell } from "../components.jsx";

export default function ExportsPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await apiGet("/api/exports"));
    } catch (err) {
      setError(err);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (error && !data) return <ErrorState error={error} />;
  if (!data) return <LoadingState label="Loading export history" />;

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Batch Audit</p>
          <h2>Shipment Exports</h2>
        </div>
        <button className="icon-button" onClick={load} type="button">
          <RefreshCw size={17} aria-hidden="true" />
          <span>Refresh</span>
        </button>
      </div>
      <TableShell>
        <table>
          <thead>
            <tr>
              <th>Batch</th>
              <th>As Of</th>
              <th>Exported</th>
              <th>Status</th>
              <th>Shipments</th>
              <th>CSV</th>
            </tr>
          </thead>
          <tbody>
            {data.batches.map((batch) => (
              <tr key={batch.id}>
                <td>#{batch.id}</td>
                <td>{batch.as_of_date}</td>
                <td>{batch.exported_at}</td>
                <td><StatusPill tone="good">{batch.status}</StatusPill></td>
                <td>{batch.persisted_shipment_count}</td>
                <td>
                  <a className="download-link" href={`/api/exports/${batch.id}.csv`}>
                    <FileDown size={16} aria-hidden="true" />
                    {batch.csv_filename}
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableShell>
    </section>
  );
}
