import { NavLink } from "react-router-dom";

import { ThemeControl } from "./ThemeControl.jsx";
import "../styles/Sidebar.css";

const NAV_ICONS = {
  home: <><path d="M4 10.5 12 4l8 6.5" /><path d="M6.5 9.5V20h11V9.5" /><path d="M10 20v-6h4v6" /></>,
  papers: <><path d="M6 3.5h9l3 3V20.5H6z" /><path d="M15 3.5v3h3" /><path d="M9 11h6M9 14.5h6" /></>,
  projects: <><rect x="3.5" y="4" width="7" height="6" rx="2" /><rect x="13.5" y="14" width="7" height="6" rx="2" /><path d="M10.5 7h4a3 3 0 0 1 3 3v4M13.5 17h-4a3 3 0 0 1-3-3v-4" /></>,
  artifacts: <><path d="M5 7.5 12 4l7 3.5-7 3.5z" /><path d="m5 12 7 3.5 7-3.5M5 16.5 12 20l7-3.5" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 5 5" /></>,
  importPaper: <><path d="M6 3.5h8.5l3.5 3.5v13.5H6z" /><path d="M14.5 3.5V7H18M12 10v7M8.5 13.5H15.5" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19 13.5v-3l-2-.7-.7-1.7.9-1.9-2.1-2.1-1.9.9-1.7-.7-.7-2h-3l-.7 2-1.7.7-1.9-.9-2.1 2.1.9 1.9-.7 1.7-2 .7v3l2 .7.7 1.7-.9 1.9 2.1 2.1 1.9-.9 1.7.7.7 2h3l.7-2 1.7-.7 1.9.9 2.1-2.1-.9-1.9.7-1.7z" /></>
};

function NavIcon({ name }) {
  return <svg aria-hidden="true" className="nav-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">{NAV_ICONS[name]}</svg>;
}

function authLabel(authInfo, fallback) {
  if (fallback) return fallback;
  const user = authInfo?.user;
  if (typeof user === "string" && user.trim()) return user;
  if (user?.name) return user.name;
  if (user?.username) return user.username;
  if (authInfo?.name) return authInfo.name;
  return "已登录";
}

export function Sidebar({ authInfo, authStatusLabel, isLoggingOut = false, onLogout, onOpenPaperImport, onOpenSearch, statusMessage }) {
  const canLogout = authInfo?.auth_required !== false;
  const isApplePlatform = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const searchShortcutLabel = isApplePlatform ? "⌘ K" : "Ctrl K";
  const importShortcutLabel = isApplePlatform ? "⌘ I" : "Ctrl I";
  const navSections = [
    {
      label: "研究工作区",
      items: [
        { to: "/", label: "首页", hint: "今日研究脉搏", icon: "home", end: true },
        {
          to: "/papers",
          label: "论文",
          hint: "发现、判断与深读",
          icon: "papers",
          children: [
            { to: "/papers/inbox", label: "待判断", index: "01" },
            { to: "/papers/library", label: "论文仓库", index: "02" },
            { to: "/papers/reports", label: "报告队列", index: "03" }
          ]
        },
        { to: "/projects", label: "项目", hint: "组织研究上下文", icon: "projects" },
        { to: "/artifacts", label: "产物", hint: "沉淀报告与洞察", icon: "artifacts" }
      ]
    },
    {
      label: "系统",
      items: [{ to: "/settings", label: "设置", hint: "连接、规则与任务", icon: "settings" }]
    }
  ];

  return (
    <aside className="sidebar">
      <span className="sidebar-ambient" aria-hidden="true" />
      <div className="brand">
        <div className="brand-row">
          <span className="brand-mark">
            <img src="/kris-logo.svg" alt="" />
          </span>
          <div className="brand-copy">
            <strong>KRIS</strong>
            <span>Research Intelligence</span>
          </div>
        </div>
      </div>

      <div className="sidebar-theme-row">
        <span>界面主题</span>
        <ThemeControl />
      </div>

      <button className="sidebar-search-trigger" onClick={onOpenSearch} type="button">
        <span className="sidebar-search-icon"><NavIcon name="search" /></span>
        <span className="sidebar-search-copy">搜索论文、产物与项目…</span>
        <kbd>{searchShortcutLabel}</kbd>
      </button>

      <button className="sidebar-search-trigger sidebar-import-trigger" onClick={onOpenPaperImport} type="button">
        <span className="sidebar-search-icon"><NavIcon name="importPaper" /></span>
        <span className="sidebar-search-copy">导入报告队列论文</span>
        <kbd>{importShortcutLabel}</kbd>
      </button>

      <nav className="main-nav" aria-label="主导航">
        {navSections.map((section) => (
          <section className="nav-section" key={section.label}>
            <header>{section.label}</header>
            <div className="nav-section-items">
              {section.items.map(({ to, label, hint, icon, end, children }) => (
                <div className={`nav-group ${children?.length ? "has-children" : ""}`} key={to}>
                  <NavLink className={({ isActive }) => `nav-button ${isActive ? "active" : ""}`} end={end} to={to}>
                    <span className="nav-icon-shell"><NavIcon name={icon} /></span>
                    <span className="nav-copy"><strong>{label}</strong><small>{hint}</small></span>
                    <span className="nav-arrow" aria-hidden="true">↗</span>
                  </NavLink>
                  {children?.length ? (
                    <div className="nav-submenu" aria-label={`${label}二级导航`}>
                      {children.map((item) => (
                        <NavLink className={({ isActive }) => `nav-subitem ${isActive ? "active" : ""}`} end={item.end} key={item.to} to={item.to}>
                          <span>{item.index}</span><strong>{item.label}</strong><i aria-hidden="true" />
                        </NavLink>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
        ))}
      </nav>

      <div className="sidebar-footer">
        <div className="sidebar-session" aria-label="认证状态">
          <div>
            <span>访问状态</span>
            <strong>{authLabel(authInfo, authStatusLabel)}</strong>
          </div>
          {canLogout ? (
            <button className="sidebar-logout" disabled={!onLogout || isLoggingOut} onClick={onLogout} type="button">
              {isLoggingOut ? "退出中" : "退出"}
            </button>
          ) : null}
        </div>

        <div className="status">
          <span className="status-pulse" aria-hidden="true" />
          <span><span className="status-label">系统状态</span><strong>{statusMessage || "Ready"}</strong></span>
        </div>
      </div>
    </aside>
  );
}
