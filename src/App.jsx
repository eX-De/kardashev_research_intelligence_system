import { useCallback, useEffect, useRef, useState } from "react";
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams
} from "react-router-dom";

import { ArtifactsView } from "./components/ArtifactsView.jsx";
import { ControlView } from "./components/ControlView.jsx";
import { DashboardView } from "./components/DashboardView.jsx";
import { LoginView } from "./components/LoginView.jsx";
import { OnboardingGate } from "./components/OnboardingGate.jsx";
import { PapersWorkspaceView } from "./components/PapersWorkspaceView.jsx";
import { ProjectPage } from "./components/ProjectPage.jsx";
import { ProjectsView } from "./components/ProjectsView.jsx";
import { Sidebar } from "./components/Sidebar.jsx";
import { ToastHost } from "./components/ToastHost.jsx";
import { ApiCacheProvider } from "./lib/apiCache.jsx";
import { AUTH_REQUIRED_EVENT, api, postJson } from "./lib/dashboard.js";
import { useServerEvents } from "./lib/serverEvents.js";
import { ThemeProvider } from "./lib/theme.jsx";

const TOAST_TYPES = new Set(["success", "error", "info", "warning"]);
const NOTIFICATION_TOAST_TYPES = {
  bad: "error",
  info: "info",
  neutral: "info",
  ok: "success",
  warn: "warning"
};
const DEFAULT_TOAST_DURATION = 3500;
const ERROR_TOAST_DURATION = 5500;
const MAX_TOASTS = 4;

function paperPath(section, paperId) {
  return `/papers/${section}/${encodeURIComponent(String(paperId))}`;
}

function projectPath(projectId) {
  return `/projects/${encodeURIComponent(String(projectId))}`;
}

function locationPath(location) {
  return `${location.pathname}${location.search}${location.hash}`;
}

function authFlag(data) {
  if (!data || typeof data !== "object") return null;
  for (const key of ["authenticated", "isAuthenticated", "is_authenticated"]) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      return Boolean(data[key]);
    }
  }
  return null;
}

function authStatusLabel(authInfo) {
  if (authInfo?.auth_required === false) return "无密码模式";
  return "已登录";
}

function isAuthenticatedStatus(data) {
  const flag = authFlag(data);
  if (flag !== null) return flag;
  return Boolean(data?.user || data?.session || data?.ok);
}

function safeNextPath(value, fallback = "/") {
  const rawValue = typeof value === "string" ? value.trim() : "";
  if (!rawValue.startsWith("/") || rawValue.startsWith("//") || rawValue.startsWith("/\\")) {
    return fallback;
  }

  try {
    const url = new URL(rawValue, window.location.origin);
    if (url.origin !== window.location.origin || url.pathname === "/login") {
      return fallback;
    }
    return `${url.pathname}${url.search}${url.hash}` || fallback;
  } catch {
    return fallback;
  }
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
      <Route path="/" element={<DashboardView setStatusMessage={setStatusMessage} notify={notify} />} />
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
      <Route path="/tasks" element={<Navigate to="/settings" replace />} />
      <Route path="/settings" element={<ControlView setStatusMessage={setStatusMessage} notify={notify} />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function RequireAuth({ authenticated, children }) {
  const location = useLocation();

  if (!authenticated) {
    const next = encodeURIComponent(locationPath(location));
    return <Navigate to={`/login?next=${next}`} replace />;
  }

  return children;
}

function LoginRoute({ authenticated, onLogin }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const nextPath = safeNextPath(searchParams.get("next"));

  const handleLogin = useCallback(async (password) => {
    await onLogin(password);
    navigate(nextPath, { replace: true });
  }, [navigate, nextPath, onLogin]);

  if (authenticated) {
    return <Navigate to={nextPath} replace />;
  }

  return <LoginView onLogin={handleLogin} />;
}

function AuthLoadingScreen() {
  return (
    <main className="auth-loading" aria-busy="true">
      <div className="auth-loading-panel">
        <span className="loader-dot" aria-hidden="true" />
        <strong>正在验证访问状态</strong>
      </div>
    </main>
  );
}

function ProtectedShell({ authInfo, authStatusLabel, notify, onLogout, setStatusMessage, statusMessage, toasts, onDismissToast }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const handleLogout = useCallback(async () => {
    if (isLoggingOut) return;

    setIsLoggingOut(true);
    const nextPath = safeNextPath(locationPath(location));

    try {
      const data = await onLogout();
      if (isAuthenticatedStatus(data)) {
        setIsLoggingOut(false);
        return;
      }
      navigate(`/login?next=${encodeURIComponent(nextPath)}`, { replace: true });
    } catch (error) {
      setIsLoggingOut(false);
      notify(error.message || "退出登录失败", {
        statusMessage: "退出登录失败",
        type: "error"
      });
    }
  }, [isLoggingOut, location, navigate, notify, onLogout]);

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
  }, [setStatusMessage]);

  return (
    <>
      <Sidebar
        authInfo={authInfo}
        authStatusLabel={authStatusLabel}
        isLoggingOut={isLoggingOut}
        onLogout={handleLogout}
        statusMessage={statusMessage}
      />
      <ToastHost onDismiss={onDismissToast} toasts={toasts} />
      <OnboardingGate notify={notify} setStatusMessage={setStatusMessage} />
      <main className="app-shell">
        <AppRoutes notify={notify} setStatusMessage={setStatusMessage} />
      </main>
    </>
  );
}

function ServerEventBridge({ notify, notifyNotification }) {
  useServerEvents({ notify, notifyNotification });
  return null;
}

function CachedProtectedShell(props) {
  return (
    <ApiCacheProvider>
      <ServerEventBridge notify={props.notify} notifyNotification={props.notifyNotification} />
      <ProtectedShell {...props} />
    </ApiCacheProvider>
  );
}

function AuthenticatedApp() {
  const [statusMessage, setStatusMessage] = useState("Idle");
  const [toasts, setToasts] = useState([]);
  const [authState, setAuthState] = useState({
    authenticated: false,
    checked: false,
    info: null
  });
  const location = useLocation();
  const navigate = useNavigate();
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

  const notifyNotification = useCallback((notification) => {
    if (!notification || typeof notification !== "object") return null;
    const channels = Array.isArray(notification.channels)
      ? notification.channels.map((channel) => String(channel).toLowerCase())
      : notification.channels
        ? [String(notification.channels).toLowerCase()]
        : [];
    if (!channels.includes("toast")) return null;

    const title = typeof notification.title === "string" ? notification.title.trim() : "";
    const detail = typeof notification.detail === "string" ? notification.detail.trim() : "";
    const message = [title, detail].filter(Boolean).join("：");
    if (!message) return null;

    const type = NOTIFICATION_TOAST_TYPES[notification.severity] || "info";
    return notify(message, { type });
  }, [notify]);

  useEffect(() => {
    let active = true;
    api("/api/auth/status")
      .then((data) => {
        if (!active) return;
        setAuthState({
          authenticated: isAuthenticatedStatus(data),
          checked: true,
          info: data
        });
      })
      .catch(() => {
        if (!active) return;
        setAuthState({
          authenticated: false,
          checked: true,
          info: null
        });
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const handleAuthRequired = () => {
      const nextPath = safeNextPath(locationPath(location));
      setAuthState({
        authenticated: false,
        checked: true,
        info: null
      });
      if (location.pathname !== "/login") {
        navigate(`/login?next=${encodeURIComponent(nextPath)}`, { replace: true });
      }
    };
    window.addEventListener(AUTH_REQUIRED_EVENT, handleAuthRequired);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, handleAuthRequired);
  }, [location, navigate]);

  const handleLogin = useCallback(async (password) => {
    const data = await postJson("/api/auth/login", { password });
    const flag = authFlag(data);
    if (flag === false) {
      throw new Error("密码验证失败");
    }

    setAuthState({
      authenticated: true,
      checked: true,
      info: data
    });
    setStatusMessage("Idle");
  }, []);

  const handleLogout = useCallback(async () => {
    const data = await postJson("/api/auth/logout");
    setAuthState({
      authenticated: isAuthenticatedStatus(data),
      checked: true,
      info: data
    });
    setStatusMessage("Idle");
    return data;
  }, []);

  if (!authState.checked) {
    return <AuthLoadingScreen />;
  }

  return (
    <Routes>
      <Route path="/login" element={<LoginRoute authenticated={authState.authenticated} onLogin={handleLogin} />} />
      <Route
        path="/*"
        element={
          <RequireAuth authenticated={authState.authenticated}>
            <CachedProtectedShell
              authInfo={authState.info}
              authStatusLabel={authStatusLabel(authState.info)}
              notify={notify}
              notifyNotification={notifyNotification}
              onDismissToast={dismissToast}
              onLogout={handleLogout}
              setStatusMessage={setStatusMessage}
              statusMessage={statusMessage}
              toasts={toasts}
            />
          </RequireAuth>
        }
      />
    </Routes>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <AuthenticatedApp />
      </BrowserRouter>
    </ThemeProvider>
  );
}
