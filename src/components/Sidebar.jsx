export function Sidebar({ activeView, onNavigate, statusMessage }) {
  const navView = activeView === "project" ? "projects" : activeView;
  const navItems = [
    ["projects", "项目中心", "项目、提醒和全局规模"],
    ["inbox", "论文推荐", "待判断论文与全文报告"],
    ["reports", "报告队列", "阅读器、导入和对话"],
    ["control", "配置与任务", "系统配置与任务历史"]
  ];

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">
          <img src="/research-mark.svg" alt="" />
        </span>
        <div>
          <strong>科研情报系统</strong>
          <span>Research project center</span>
        </div>
      </div>

      <nav className="main-nav" aria-label="主导航">
        {navItems.map(([view, label, hint]) => (
          <button className={`nav-button ${navView === view ? "active" : ""}`} key={view} onClick={() => onNavigate(view)} type="button">
            <span className="nav-indicator" aria-hidden="true" />
            <span>
              <strong>{label}</strong>
              <small>{hint}</small>
            </span>
          </button>
        ))}
      </nav>

      <div className="status">
        <span className="status-label">当前状态</span>
        <strong>{statusMessage || "Idle"}</strong>
      </div>
    </aside>
  );
}
