import { useEffect, useState } from "react";

import { ControlView } from "./components/ControlView.jsx";
import { InboxView } from "./components/InboxView.jsx";
import { ProjectPage } from "./components/ProjectPage.jsx";
import { ProjectsView } from "./components/ProjectsView.jsx";
import { ReportQueueView } from "./components/ReportQueueView.jsx";
import { Sidebar } from "./components/Sidebar.jsx";
import { postJson } from "./lib/dashboard.js";

export function App() {
  const [activeView, setActiveView] = useState("projects");
  const [activeProjectId, setActiveProjectId] = useState(null);
  const [statusMessage, setStatusMessage] = useState("Idle");

  useEffect(() => {
    let active = true;
    postJson("/api/jobs/startup-daily/check")
      .then((data) => {
        if (!active) return;
        if (data.startup_daily_trigger?.triggered) {
          setStatusMessage("每日流程已在后台启动");
        }
      })
      .catch((error) => {
        if (active) setStatusMessage(error.message);
      });
    return () => {
      active = false;
    };
  }, []);

  function navigate(view) {
    setActiveView(view);
    if (view !== "project") setActiveProjectId(null);
  }

  function openProject(projectId) {
    setActiveProjectId(projectId);
    setActiveView("project");
  }

  function newProject() {
    setActiveProjectId(null);
    setActiveView("project");
  }

  return (
    <>
      <Sidebar activeView={activeView} onNavigate={navigate} statusMessage={statusMessage} />
      <main className="app-shell">
        {activeView === "projects" ? <ProjectsView onOpenProject={openProject} onNewProject={newProject} setStatusMessage={setStatusMessage} /> : null}
        {activeView === "project" ? (
          <ProjectPage
            projectId={activeProjectId}
            onBack={() => navigate("projects")}
            onSavedProject={openProject}
            setStatusMessage={setStatusMessage}
          />
        ) : null}
        {activeView === "inbox" ? <InboxView setStatusMessage={setStatusMessage} /> : null}
        {activeView === "reports" ? <ReportQueueView setStatusMessage={setStatusMessage} /> : null}
        {activeView === "control" ? <ControlView setStatusMessage={setStatusMessage} /> : null}
      </main>
    </>
  );
}
