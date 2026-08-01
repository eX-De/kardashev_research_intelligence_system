import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
import { GlobalSearchDialog } from "./components/GlobalSearchDialog.jsx";
import { LoginView } from "./components/LoginView.jsx";
import { OnboardingGate } from "./components/OnboardingGate.jsx";
import { PapersWorkspaceView } from "./components/PapersWorkspaceView.jsx";
import { ProjectPage } from "./components/ProjectPage.jsx";
import { ProjectsView } from "./components/ProjectsView.jsx";
import { Sidebar } from "./components/Sidebar.jsx";
import { ToastHost } from "./components/ToastHost.jsx";
import { ApiCacheProvider, useApiCacheClient } from "./lib/apiCache.jsx";
import { AUTH_REQUIRED_EVENT, api, postJson } from "./lib/dashboard.js";
import { LocaleProvider, useLocale } from "./lib/locale.jsx";
import { useServerEvents } from "./lib/serverEvents.js";
import { formatApiError } from "./lib/systemMessages.js";
import { ThemeProvider } from "./lib/theme.jsx";
import "./styles/App.css";

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

function authStatusLabel(authInfo, t) {
  if (authInfo?.auth_required === false) return t("auth.noPassword");
  return t("auth.loggedIn");
}

function isMessageDescriptor(message) {
  return Boolean(message && typeof message === "object" && typeof message.key === "string");
}

function isSystemNotificationDescriptor(message) {
  return Boolean(message && typeof message === "object" && message.kind === "system-notification" && message.notification);
}

function messageHasContent(message) {
  if (typeof message === "string") return Boolean(message.trim());
  if (isSystemNotificationDescriptor(message)) return true;
  return isMessageDescriptor(message) && Boolean(message.key.trim() || String(message.fallback || "").trim());
}

function resolveMessage(t, message) {
  if (isSystemNotificationDescriptor(message)) return "";
  if (!isMessageDescriptor(message)) return String(message ?? "");
  return t(message.key, {
    ...(message.values || {}),
    defaultValue: message.fallback,
    ns: message.namespace
  });
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

function PapersRoute({ importOpen = false, notify, onClosePaperImport, section, setStatusMessage }) {
  const navigate = useNavigate();
  const { paperId } = useParams();

  const selectPaper = useCallback((targetPaperId, options = {}) => {
    if (!targetPaperId) return;
    navigate(paperPath(section, targetPaperId), { replace: Boolean(options.replace) });
  }, [navigate, section]);

  const openLibraryPaper = useCallback((targetPaperId, options = {}) => {
    if (!targetPaperId) return;
    navigate(paperPath("library", targetPaperId), { replace: Boolean(options.replace) });
  }, [navigate]);

  const openChat = useCallback((targetPaperId, options = {}) => {
    if (!targetPaperId) return;
    navigate(paperPath("chat", targetPaperId), { replace: Boolean(options.replace) });
  }, [navigate]);

  return (
    <PapersWorkspaceView
      importOpen={importOpen}
      notify={notify}
      onClosePaperImport={onClosePaperImport}
      section={section}
      onOpenChat={openChat}
      onOpenLibraryPaper={openLibraryPaper}
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

function AppRoutes({ importOpen, notify, onClosePaperImport, setStatusMessage }) {
  return (
    <Routes>
      <Route path="/" element={<DashboardView setStatusMessage={setStatusMessage} notify={notify} />} />
      <Route path="/artifacts" element={<ArtifactsRoute setStatusMessage={setStatusMessage} />} />
      <Route path="/artifacts/:artifactId" element={<ArtifactsRoute setStatusMessage={setStatusMessage} />} />
      <Route path="/papers" element={<Navigate to="/papers/inbox" replace />} />
      <Route path="/papers/inbox" element={<PapersRoute notify={notify} section="inbox" setStatusMessage={setStatusMessage} />} />
      <Route path="/papers/inbox/:paperId" element={<PapersRoute notify={notify} section="inbox" setStatusMessage={setStatusMessage} />} />
      <Route path="/papers/library" element={<PapersRoute importOpen={importOpen} notify={notify} onClosePaperImport={onClosePaperImport} section="library" setStatusMessage={setStatusMessage} />} />
      <Route path="/papers/library/:paperId" element={<PapersRoute importOpen={importOpen} notify={notify} onClosePaperImport={onClosePaperImport} section="library" setStatusMessage={setStatusMessage} />} />
      <Route path="/papers/chat" element={<PapersRoute notify={notify} section="chat" setStatusMessage={setStatusMessage} />} />
      <Route path="/papers/chat/:paperId" element={<PapersRoute notify={notify} section="chat" setStatusMessage={setStatusMessage} />} />
      <Route path="/papers/reports" element={<LegacyReportRoute />} />
      <Route path="/papers/reports/:paperId" element={<LegacyReportRoute />} />
      <Route path="/projects" element={<ProjectsRoute setStatusMessage={setStatusMessage} />} />
      <Route path="/projects/new" element={<ProjectPageRoute isNew setStatusMessage={setStatusMessage} />} />
      <Route path="/projects/:projectId" element={<ProjectPageRoute setStatusMessage={setStatusMessage} />} />
      <Route path="/tasks" element={<Navigate to="/settings/daily-tasks" replace />} />
      <Route path="/settings/*" element={<ControlView setStatusMessage={setStatusMessage} notify={notify} />} />
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
  const { t } = useTranslation("app");
  return (
    <main className="auth-loading" aria-busy="true">
      <div className="auth-loading-panel">
        <span className="loader-dot" aria-hidden="true" />
        <strong>{t("auth.checking")}</strong>
      </div>
    </main>
  );
}

function ProtectedShell({ authInfo, authStatusLabel, notify, onLogout, setStatusMessage, statusMessage, toasts, onDismissToast }) {
  const { t } = useTranslation("app");
  const location = useLocation();
  const navigate = useNavigate();
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isPaperImportOpen, setIsPaperImportOpen] = useState(false);
  const openSearch = useCallback(() => {
    setIsPaperImportOpen(false);
    setIsSearchOpen(true);
  }, []);
  const closeSearch = useCallback(() => setIsSearchOpen(false), []);
  const closePaperImport = useCallback(() => setIsPaperImportOpen(false), []);
  const openPaperImport = useCallback(() => {
    setIsSearchOpen(false);
    setIsPaperImportOpen(true);
    if (!location.pathname.startsWith("/papers/library")) navigate("/papers/library");
  }, [location.pathname, navigate]);

  useEffect(() => {
    if (!location.pathname.startsWith("/papers/library")) setIsPaperImportOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    const handlePaperImportShortcut = (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "i") return;
      event.preventDefault();
      openPaperImport();
    };
    window.addEventListener("keydown", handlePaperImportShortcut);
    return () => window.removeEventListener("keydown", handlePaperImportShortcut);
  }, [openPaperImport]);

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
      notify(formatApiError(error, t, "app:auth.logoutFailed"), {
        statusMessage: t("auth.logoutFailed"),
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
          setStatusMessage(t("status.dailyStarted"));
        }
      })
      .catch((error) => {
        if (active) setStatusMessage(formatApiError(error, t));
      });
    return () => {
      active = false;
    };
  }, [setStatusMessage, t]);

  return (
    <>
      <Sidebar
        authInfo={authInfo}
        authStatusLabel={authStatusLabel}
        isLoggingOut={isLoggingOut}
        onLogout={handleLogout}
        onOpenPaperImport={openPaperImport}
        onOpenSearch={openSearch}
        statusMessage={statusMessage}
      />
      <GlobalSearchDialog
        isOpen={isSearchOpen}
        onClose={closeSearch}
        onOpen={openSearch}
        setStatusMessage={setStatusMessage}
      />
      <ToastHost onDismiss={onDismissToast} toasts={toasts} />
      <OnboardingGate notify={notify} setStatusMessage={setStatusMessage} />
      <main className="app-shell">
        <AppRoutes
          importOpen={isPaperImportOpen}
          notify={notify}
          onClosePaperImport={closePaperImport}
          setStatusMessage={setStatusMessage}
        />
      </main>
    </>
  );
}

function ServerEventBridge({ notify, notifyNotification }) {
  useServerEvents({ notify, notifyNotification });
  return null;
}

function PaperReaderPromptLocaleSync() {
  const { locale } = useLocale();
  const cache = useApiCacheClient();

  useEffect(() => {
    let active = true;
    postJson("/api/settings", { paper_reader_prompt_locale: locale })
      .then((data) => {
        if (active) cache.setCache(["settings"], data);
      })
      .catch(() => {
        // The active locale remains browser-persistent even if server sync is temporarily unavailable.
      });
    return () => {
      active = false;
    };
  }, [cache, locale]);

  return null;
}

function CachedProtectedShell(props) {
  return (
    <ApiCacheProvider>
      <PaperReaderPromptLocaleSync />
      <ServerEventBridge notify={props.notify} notifyNotification={props.notifyNotification} />
      <ProtectedShell {...props} />
    </ApiCacheProvider>
  );
}

function AuthenticatedApp() {
  const { t } = useTranslation("app");
  const [statusMessage, setStatusMessage] = useState(() => t("status.idle"));
  const [toasts, setToasts] = useState([]);
  const [authState, setAuthState] = useState({
    authenticated: false,
    checked: false,
    info: null
  });
  const location = useLocation();
  const navigate = useNavigate();
  const toastIdRef = useRef(0);
  const toastDedupeRef = useRef(new Set());

  const dismissToast = useCallback((toastId) => {
    setToasts((current) => current.filter((toast) => toast.id !== toastId));
  }, []);

  const notify = useCallback((message, options = {}) => {
    if (!messageHasContent(message)) return null;

    const notificationId = isSystemNotificationDescriptor(message)
      ? String(message.notification?.id || "").trim()
      : "";
    const dedupeKey = String(options.dedupeKey || notificationId).trim();
    if (dedupeKey && toastDedupeRef.current.has(dedupeKey)) return null;
    if (dedupeKey) {
      toastDedupeRef.current.add(dedupeKey);
      if (toastDedupeRef.current.size > 256) {
        toastDedupeRef.current.delete(toastDedupeRef.current.values().next().value);
      }
    }

    const type = TOAST_TYPES.has(options.type) ? options.type : "info";
    const duration = Number.isFinite(options.duration)
      ? Math.max(0, options.duration)
      : type === "error"
        ? ERROR_TOAST_DURATION
        : DEFAULT_TOAST_DURATION;
    const id = `toast-${Date.now()}-${toastIdRef.current + 1}`;
    toastIdRef.current += 1;

    setToasts((current) => [...current, { dedupeKey, duration, id, message, type }].slice(-MAX_TOASTS));

    if (options.statusMessage) {
      setStatusMessage(resolveMessage(t, options.statusMessage));
    }

    return id;
  }, [t]);

  const notifyNotification = useCallback((notification) => {
    if (!notification || typeof notification !== "object") return null;
    const channels = Array.isArray(notification.channels)
      ? notification.channels.map((channel) => String(channel).toLowerCase())
      : notification.channels
        ? [String(notification.channels).toLowerCase()]
        : [];
    if (!channels.includes("toast")) return null;

    const type = NOTIFICATION_TOAST_TYPES[notification.severity] || "info";
    return notify({ kind: "system-notification", notification }, { type });
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
      throw new Error(t("auth.loginFailed"));
    }

    setAuthState({
      authenticated: true,
      checked: true,
      info: data
    });
    setStatusMessage(t("status.idle"));
  }, [t]);

  const handleLogout = useCallback(async () => {
    const data = await postJson("/api/auth/logout");
    setAuthState({
      authenticated: isAuthenticatedStatus(data),
      checked: true,
      info: data
    });
    setStatusMessage(t("status.idle"));
    return data;
  }, [t]);

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
              authStatusLabel={authStatusLabel(authState.info, t)}
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
    <LocaleProvider>
      <ThemeProvider>
        <BrowserRouter>
          <AuthenticatedApp />
        </BrowserRouter>
      </ThemeProvider>
    </LocaleProvider>
  );
}

function LegacyReportRoute() {
  const { paperId } = useParams();
  return <Navigate replace to={paperId ? paperPath("library", paperId) : "/papers/library"} />;
}
