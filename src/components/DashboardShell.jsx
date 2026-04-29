import { ControlView } from "./ControlView.jsx";
import { InboxView } from "./InboxView.jsx";
import { ProjectsView } from "./ProjectsView.jsx";
import { Sidebar } from "./Sidebar.jsx";

export function DashboardShell() {
  return (
    <>
      <Sidebar />
      <main className="app-shell">
        <ProjectsView />
        <InboxView />
        <ControlView />
      </main>
    </>
  );
}
