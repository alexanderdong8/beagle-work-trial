import EligibilityPage from "./pages/EligibilityPage.jsx";

export default function App() {
  // Single-screen app for the first milestone. Import/manual-review navigation
  // can be added later without changing the shipment batch flow.
  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Corgi Operations</p>
          <h1>Air Filter Shipments</h1>
        </div>
      </header>
      <EligibilityPage />
    </main>
  );
}
