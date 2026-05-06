export function Sidebar({ activeView, onNavigate, statusMessage }) {
  const navView = activeView === "project" ? "projects" : activeView;

  return (
    <aside className="sidebar">
      <div className="brand">
        <img src="/research-mark.svg" alt="" />
        <div>
          <strong>科研情报系统</strong>
          <span>Research project center</span>
        </div>
      </div>

      <nav className="main-nav" aria-label="主导航">
        <button className={`nav-button ${navView === "projects" ? "active" : ""}`} onClick={() => onNavigate("projects")} type="button">
          项目中心
        </button>
        <button className={`nav-button ${navView === "inbox" ? "active" : ""}`} onClick={() => onNavigate("inbox")} type="button">
          论文推荐
        </button>
        <button className={`nav-button ${navView === "control" ? "active" : ""}`} onClick={() => onNavigate("control")} type="button">
          配置与任务
        </button>
      </nav>

      <div className="status">{statusMessage || "Idle"}</div>
    </aside>
  );
}
