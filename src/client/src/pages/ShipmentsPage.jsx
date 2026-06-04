import { useCallback, useEffect, useState } from "react";
import { apiGet } from "../api.js";
import { ErrorState, LoadingState, StatusPill, TableShell } from "../components.jsx";

function statusTone(status) {
  if (status === "ordered") return "warn";
  if (status === "historical" || status === "delivered" || status === "confirmed") return "good";
  return "neutral";
}

export default function ShipmentsPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await apiGet("/api/shipments"));
    } catch (err) {
      setError(err);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (error && !data) return <ErrorState error={error} />;
  if (!data) return <LoadingState label="Loading shipments" />;

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Unified Shipment Table</p>
          <h2>Shipments And Orders</h2>
        </div>
        <StatusPill>{data.shipments.length} rows</StatusPill>
      </div>
      <TableShell>
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Recipient</th>
              <th>Property</th>
              <th>Status</th>
              <th>Tracking</th>
              <th>Next Eligible</th>
            </tr>
          </thead>
          <tbody>
            {data.shipments.map((row) => (
              <tr key={row.id}>
                <td>{row.shipment_date}</td>
                <td>
                  <strong>{row.recipient_name}</strong>
                  <small>Tenant #{row.tenant_id}</small>
                </td>
                <td>
                  {row.property_name}
                  <small>{row.property_id}</small>
                </td>
                <td><StatusPill tone={statusTone(row.status)}>{row.status}</StatusPill></td>
                <td>{row.tracking_number || "Pending"}</td>
                <td>{row.minimum_next_shipment_date}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableShell>
    </section>
  );
}
