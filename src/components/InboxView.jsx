export function InboxView() {
  return (
    <section id="inboxView" className="view inbox-view is-hidden">
      <section className="inbox-panel" aria-label="论文 inbox">
        <header className="panel-header">
          <div>
            <h1>论文推荐</h1>
            <p id="inboxMeta">Loading recommendations...</p>
          </div>
          <button id="refreshButton" className="icon-button" title="刷新" aria-label="刷新" type="button">
            <span aria-hidden="true">↻</span>
          </button>
        </header>
        <div className="paper-list" id="paperList" />
      </section>

      <section className="detail-panel" aria-label="论文详情">
        <div id="paperDetail" className="empty-detail">
          <h2>选择一篇论文</h2>
          <p>摘要、证据片段和标注操作会显示在这里。</p>
        </div>
      </section>
    </section>
  );
}
