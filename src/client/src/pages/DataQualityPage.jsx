import { useCallback, useEffect, useState } from "react";
import { apiGet } from "../api.js";
import { ErrorState, LoadingState, Stat, StatusPill, TableShell } from "../components.jsx";

export default function DataQualityPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await apiGet("/api/data-quality"));
    } catch (err) {
      setError(err);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (error && !data) return <ErrorState error={error} />;
  if (!data) return <LoadingState label="Loading data-quality report" />;

  return (
    <section className="page-grid">
      <div className="panel page-hero">
        <div>
          <p className="eyebrow">Normalization Report</p>
          <h2>Data Quality Issues</h2>
        </div>
      </div>
      <div className="stats-row">
        {data.issueCounts.map((issue) => (
          <Stat key={issue.issue_type} label={issue.issue_type.replaceAll("_", " ")} value={issue.count} />
        ))}
      </div>
      <section className="panel">
        <div className="section-heading">
          <h3>Findings And Resolutions</h3>
          <StatusPill>{data.issues.length} issues</StatusPill>
        </div>
        <TableShell>
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Tenant</th>
                <th>Property</th>
                <th>Details</th>
                <th>Resolution</th>
              </tr>
            </thead>
            <tbody>
              {data.issues.map((issue) => (
                <tr key={issue.id}>
                  <td><StatusPill>{issue.issue_type}</StatusPill></td>
                  <td>
                    {issue.tenant_id || "N/A"}
                    {issue.related_tenant_id ? <small>related #{issue.related_tenant_id}</small> : null}
                  </td>
                  <td>
                    {issue.property_id || "N/A"}
                    {issue.related_property_id ? <small>related {issue.related_property_id}</small> : null}
                  </td>
                  <td>{issue.details}</td>
                  <td>{issue.resolution}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableShell>
      </section>
    </section>
  );
}
