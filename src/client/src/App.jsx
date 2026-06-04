import EligibilityPage from "./pages/EligibilityPage.jsx";

export default function App() {
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
