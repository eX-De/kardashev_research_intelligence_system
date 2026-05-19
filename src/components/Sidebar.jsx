import { NavLink } from "react-router-dom";

export function Sidebar({ statusMessage }) {
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
    { to: "/tasks", label: "任务", hint: "运行控制台" },
    { to: "/settings", label: "设置", hint: "系统连接与规则" }
  ];

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">
          <img src="/research-mark.svg" alt="" />
        </span>
        <div>
          <strong>科研情报系统</strong>
          <span>System-first workspace</span>
        </div>
      </div>

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

      <div className="status">
        <span className="status-label">当前状态</span>
        <strong>{statusMessage || "Idle"}</strong>
      </div>
    </aside>
  );
}
