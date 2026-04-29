import { useEffect } from "react";

import { DashboardShell } from "./components/DashboardShell.jsx";
import { initDashboard } from "./legacyDashboard.js";

export function App() {
  useEffect(() => {
    initDashboard();
  }, []);

  return <DashboardShell />;
}
