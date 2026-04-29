export function Sidebar() {
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
        <button className="nav-button active" data-view="projects" type="button">
          项目中心
        </button>
        <button className="nav-button" data-view="inbox" type="button">
          论文推荐
        </button>
        <button className="nav-button" data-view="control" type="button">
          配置与任务
        </button>
      </nav>

      <div className="status" id="jobStatus">
        Idle
      </div>
    </aside>
  );
}
