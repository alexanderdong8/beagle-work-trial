export function LoadingState({ label = "Loading" }) {
  return <div className="empty-state">{label}</div>;
}

export function ErrorState({ error }) {
  return <div className="error-state">{error.message || String(error)}</div>;
}

export function Stat({ label, value }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function StatusPill({ children, tone = "neutral" }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

export function TableShell({ children }) {
  return <div className="table-shell">{children}</div>;
}
