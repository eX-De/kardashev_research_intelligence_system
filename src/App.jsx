import { useCallback, useEffect, useRef, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";

import { ArtifactsView } from "./components/ArtifactsView.jsx";
import { ControlView } from "./components/ControlView.jsx";
import { DashboardView } from "./components/DashboardView.jsx";
import { PapersWorkspaceView } from "./components/PapersWorkspaceView.jsx";
import { ProjectPage } from "./components/ProjectPage.jsx";
import { ProjectsView } from "./components/ProjectsView.jsx";
import { Sidebar } from "./components/Sidebar.jsx";
import { TasksView } from "./components/TasksView.jsx";
import { ToastHost } from "./components/ToastHost.jsx";
import { postJson } from "./lib/dashboard.js";

const TOAST_TYPES = new Set(["success", "error", "info", "warning"]);
const DEFAULT_TOAST_DURATION = 3500;
const ERROR_TOAST_DURATION = 5500;
const MAX_TOASTS = 4;

function paperPath(section, paperId) {
  return `/papers/${section}/${encodeURIComponent(String(paperId))}`;
}

function projectPath(projectId) {
  return `/projects/${encodeURIComponent(String(projectId))}`;
}

function PapersRoute({ section, setStatusMessage }) {
  const navigate = useNavigate();
  const { paperId } = useParams();

  const selectPaper = useCallback((targetPaperId, options = {}) => {
    if (!targetPaperId) return;
    navigate(paperPath(section, targetPaperId), { replace: Boolean(options.replace) });
  }, [navigate, section]);

  const openReportQueue = useCallback((targetPaperId, options = {}) => {
    if (!targetPaperId) return;
    navigate(paperPath("reports", targetPaperId), { replace: Boolean(options.replace) });
  }, [navigate]);

  return (
    <PapersWorkspaceView
      section={section}
      onOpenReportQueue={openReportQueue}
      onSelectPaper={selectPaper}
      selectedPaperId={paperId}
      setStatusMessage={setStatusMessage}
    />
  );
}

function ProjectsRoute({ setStatusMessage }) {
  const navigate = useNavigate();

  return (
    <ProjectsView
      onOpenProject={(projectId) => navigate(projectPath(projectId))}
      onNewProject={() => navigate("/projects/new")}
      setStatusMessage={setStatusMessage}
    />
  );
}

function ProjectPageRoute({ isNew = false, setStatusMessage }) {
  const navigate = useNavigate();
  const { projectId } = useParams();

  return (
    <ProjectPage
      projectId={isNew ? null : projectId}
      onBack={() => navigate("/projects")}
      onSavedProject={(savedProjectId) => navigate(projectPath(savedProjectId), { replace: true })}
      setStatusMessage={setStatusMessage}
    />
  );
}

function ArtifactsRoute({ setStatusMessage }) {
  const navigate = useNavigate();
  const { artifactId } = useParams();

  return (
    <ArtifactsView
      onSelectArtifact={(nextArtifactId) => navigate(`/artifacts/${encodeURIComponent(String(nextArtifactId))}`)}
      selectedArtifactId={artifactId}
      setStatusMessage={setStatusMessage}
    />
  );
}

function AppRoutes({ notify, setStatusMessage }) {
  return (
    <Routes>
      <Route path="/" element={<DashboardView setStatusMessage={setStatusMessage} />} />
      <Route path="/artifacts" element={<ArtifactsRoute setStatusMessage={setStatusMessage} />} />
      <Route path="/artifacts/:artifactId" element={<ArtifactsRoute setStatusMessage={setStatusMessage} />} />
      <Route path="/papers" element={<Navigate to="/papers/inbox" replace />} />
      <Route path="/papers/inbox" element={<PapersRoute section="inbox" setStatusMessage={setStatusMessage} />} />
      <Route path="/papers/inbox/:paperId" element={<PapersRoute section="inbox" setStatusMessage={setStatusMessage} />} />
      <Route path="/papers/library" element={<PapersRoute section="library" setStatusMessage={setStatusMessage} />} />
      <Route path="/papers/library/:paperId" element={<PapersRoute section="library" setStatusMessage={setStatusMessage} />} />
      <Route path="/papers/reports" element={<PapersRoute section="reports" setStatusMessage={setStatusMessage} />} />
      <Route path="/papers/reports/:paperId" element={<PapersRoute section="reports" setStatusMessage={setStatusMessage} />} />
      <Route path="/projects" element={<ProjectsRoute setStatusMessage={setStatusMessage} />} />
      <Route path="/projects/new" element={<ProjectPageRoute isNew setStatusMessage={setStatusMessage} />} />
      <Route path="/projects/:projectId" element={<ProjectPageRoute setStatusMessage={setStatusMessage} />} />
      <Route path="/tasks" element={<TasksView setStatusMessage={setStatusMessage} />} />
      <Route path="/settings" element={<ControlView setStatusMessage={setStatusMessage} notify={notify} />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export function App() {
  const [statusMessage, setStatusMessage] = useState("Idle");
  const [toasts, setToasts] = useState([]);
  const toastIdRef = useRef(0);

  const dismissToast = useCallback((toastId) => {
    setToasts((current) => current.filter((toast) => toast.id !== toastId));
  }, []);

  const notify = useCallback((message, options = {}) => {
    const text = typeof message === "string" ? message : String(message ?? "");
    if (!text.trim()) return null;

    const type = TOAST_TYPES.has(options.type) ? options.type : "info";
    const duration = Number.isFinite(options.duration)
      ? Math.max(0, options.duration)
      : type === "error"
        ? ERROR_TOAST_DURATION
        : DEFAULT_TOAST_DURATION;
    const id = `toast-${Date.now()}-${toastIdRef.current + 1}`;
    toastIdRef.current += 1;

    setToasts((current) => [...current, { duration, id, message: text, type }].slice(-MAX_TOASTS));

    if (options.statusMessage) {
      setStatusMessage(typeof options.statusMessage === "string" ? options.statusMessage : text);
    }

    return id;
  }, []);

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

  return (
    <BrowserRouter>
      <Sidebar statusMessage={statusMessage} />
      <ToastHost onDismiss={dismissToast} toasts={toasts} />
      <main className="app-shell">
        <AppRoutes notify={notify} setStatusMessage={setStatusMessage} />
      </main>
    </BrowserRouter>
  );
}
