import { FileInput, PackageCheck } from "lucide-react";
import { useState } from "react";
import EligibilityPage from "./pages/EligibilityPage.jsx";
import ImportPage from "./pages/ImportPage.jsx";

const tabs = [
  { id: "ship", label: "Ship Batch", icon: PackageCheck },
  { id: "import", label: "Import", icon: FileInput },
];

export default function App() {
  // Two operational workflows: outbound export and inbound ShipStation import.
  const [activeTab, setActiveTab] = useState("ship");

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Corgi Operations</p>
          <h1>Air Filter Shipments</h1>
        </div>
        <nav className="tabs" aria-label="Primary">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                className={activeTab === tab.id ? "tab tab-active" : "tab"}
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                type="button"
              >
                <Icon size={16} aria-hidden="true" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </nav>
      </header>
      {activeTab === "import" ? <ImportPage /> : <EligibilityPage />}
    </main>
  );
}
