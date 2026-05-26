import { NavLink } from "react-router-dom";

import { ThemeControl } from "./ThemeControl.jsx";

function authLabel(authInfo, fallback) {
  if (fallback) return fallback;
  const user = authInfo?.user;
  if (typeof user === "string" && user.trim()) return user;
  if (user?.name) return user.name;
  if (user?.username) return user.username;
  if (authInfo?.name) return authInfo.name;
  return "已登录";
}

export function Sidebar({ authInfo, authStatusLabel, isLoggingOut = false, onLogout, statusMessage }) {
  const canLogout = authInfo?.auth_required !== false;
  const navItems = [
    { to: "/", label: "首页", hint: "今日工作台", end: true },
    {
      to: "/papers",
      label: "论文",
      hint: "推荐、仓库和报告",
      children: [
        { to: "/papers/inbox", label: "待判断" },
        { to: "/papers/library", label: "仓库" },
        { to: "/papers/reports", label: "报告队列" }
      ]
    },
    { to: "/projects", label: "项目", hint: "上下文、论文和产物" },
    { to: "/artifacts", label: "产物", hint: "日报、摘要和报告" },
    { to: "/settings", label: "设置", hint: "系统连接、规则和任务" }
  ];

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-row">
          <span className="brand-mark">
            <img src="/kris-logo.svg" alt="" />
          </span>
          <div className="brand-copy">
            <strong>KRIS</strong>
            <span>Kardashev Research Intelligence System</span>
          </div>
        </div>
      </div>

      <ThemeControl />

      <nav className="main-nav" aria-label="主导航">
        {navItems.map(({ to, label, hint, end, children }) => (
          <div className="nav-group" key={to}>
            <NavLink
              className={({ isActive }) => `nav-button ${isActive ? "active" : ""}`}
              end={end}
              to={to}
            >
              <span className="nav-indicator" aria-hidden="true" />
              <span>
                <strong>{label}</strong>
                <small>{hint}</small>
              </span>
            </NavLink>
            {children?.length ? (
              <div className="nav-submenu" aria-label={`${label}二级导航`}>
                {children.map((item) => (
                  <NavLink
                    className={({ isActive }) => `nav-subitem ${isActive ? "active" : ""}`}
                    end={item.end}
                    key={item.to}
                    to={item.to}
                  >
                    {item.label}
                  </NavLink>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </nav>

      <div className="sidebar-session" aria-label="认证状态">
        <div>
          <span>访问状态</span>
          <strong>{authLabel(authInfo, authStatusLabel)}</strong>
        </div>
        {canLogout ? (
          <button className="sidebar-logout" disabled={!onLogout || isLoggingOut} onClick={onLogout} type="button">
            {isLoggingOut ? "退出中" : "退出登录"}
          </button>
        ) : null}
      </div>

      <div className="status">
        <span className="status-label">当前状态</span>
        <strong>{statusMessage || "Idle"}</strong>
      </div>
    </aside>
  );
}
