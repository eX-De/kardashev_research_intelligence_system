import { csv } from "../lib/dashboard.js";
import { TaskControlPanel } from "./TaskControlPanel.jsx";
import { TaskHistoryPanel } from "./TaskHistoryPanel.jsx";
import "../styles/SettingsForm.css";
import "../styles/DailyTasksSettingsView.css";

const SAVE_STATUS_LABELS = {
  idle: "未修改",
  dirty: "保存中",
  saving: "保存中",
  saved: "已保存",
  error: "保存失败"
};

function SettingsSection({ eyebrow, title, description, children }) {
  return (
    <section className="settings-section daily-tasks-settings-section">
      <div className="settings-section-head">
        <div>
          <span>{eyebrow}</span>
          <h3>{title}</h3>
        </div>
        <p>{description}</p>
      </div>
      <div className="settings-field-grid">{children}</div>
    </section>
  );
}

function TextField({ label, name, placeholder, value, onChange }) {
  return (
    <label>
      <span>{label}</span>
      <input
        name={name}
        placeholder={placeholder}
        value={csv(value)}
        onChange={(event) => onChange(name, event.target.value)}
      />
    </label>
  );
}

function NumberField({ label, name, min, max, step, value, onChange }) {
  return (
    <label>
      <span>{label}</span>
      <input
        name={name}
        type="number"
        min={min}
        max={max}
        step={step}
        value={value ?? ""}
        onChange={(event) => onChange(name, event.target.value)}
      />
    </label>
  );
}

function CheckboxField({ label, name, checked, onChange }) {
  return (
    <label className="settings-checkbox-row">
      <input
        className="settings-checkbox-input"
        name={name}
        type="checkbox"
        checked={Boolean(checked)}
        onChange={(event) => onChange(name, event.target.checked)}
      />
      <span className="settings-checkbox-mark" aria-hidden="true">
        <svg fill="none" viewBox="0 0 12 12"><path d="m2.5 6.2 2.2 2.2 4.8-5" /></svg>
      </span>
      <span className="settings-checkbox-label">{label}</span>
    </label>
  );
}

/**
 * 每日任务二级页面。
 *
 * settings/onSettingChange/onSubmit/saveStatus 复用设置工作区的统一草稿与保存状态；
 * taskControlProps/taskHistoryProps 可直接传给现有任务组件，页面不重复持有任务状态。
 */
export function DailyTasksSettingsView({
  settings = {},
  onSettingChange = () => {},
  onSubmit,
  saveStatus = "idle",
  taskControlProps = null,
  taskHistoryProps = {}
}) {
  function submitSettings(event) {
    if (onSubmit) {
      onSubmit(event);
      return;
    }
    event.preventDefault();
  }

  return (
    <div className="daily-tasks-settings-view">
      <header className="settings-subpage-heading">
        <div>
          <span>DAILY PIPELINE</span>
          <h2>每日任务</h2>
          <p>集中管理每日研究流程的触发方式、论文召回、筛选策略和执行容量。</p>
        </div>
        <em className={`settings-subpage-save-state is-${saveStatus}`} aria-live="polite">
          {SAVE_STATUS_LABELS[saveStatus] || SAVE_STATUS_LABELS.idle}
        </em>
      </header>

      {taskControlProps ? <TaskControlPanel {...taskControlProps} /> : null}

      <form className="settings-form daily-tasks-settings-form" onSubmit={submitSettings}>
        <SettingsSection
          eyebrow="Schedule & ingestion"
          title="调度与论文抓取"
          description="定义每日流程何时运行，以及从 arXiv 获取哪些候选论文。"
        >
          <label>
            <span>每日执行时间</span>
            <input
              name="scheduler_run_time"
              type="time"
              value={settings.scheduler_run_time || ""}
              onChange={(event) => onSettingChange("scheduler_run_time", event.target.value)}
            />
          </label>
          <NumberField label="执行间隔小时" name="scheduler_interval_hours" min="1" step="1" value={settings.scheduler_interval_hours} onChange={onSettingChange} />
          <TextField label="arXiv 分类" name="arxiv_categories" placeholder="cs.AI,cs.CL,cs.IR" value={settings.arxiv_categories} onChange={onSettingChange} />
          <NumberField label="回看天数" name="arxiv_daily_lookback_days" min="1" step="1" value={settings.arxiv_daily_lookback_days} onChange={onSettingChange} />
          <NumberField label="最大抓取数" name="arxiv_max_results" min="1" step="1" value={settings.arxiv_max_results} onChange={onSettingChange} />
          <NumberField label="请求间隔秒数" name="arxiv_request_interval_seconds" min="3" step="0.5" value={settings.arxiv_request_interval_seconds} onChange={onSettingChange} />
        </SettingsSection>

        <SettingsSection
          eyebrow="Retrieval & ranking"
          title="检索与推荐"
          description="控制候选论文进入 inbox 前的召回、摘要粗筛和证据数量。"
        >
          <NumberField label="RAG 阈值" name="rag_score_threshold" min="0" max="1" step="0.01" value={settings.rag_score_threshold} onChange={onSettingChange} />
          <NumberField label="证据 Top K" name="rag_top_k" min="1" step="1" value={settings.rag_top_k} onChange={onSettingChange} />
          <TextField label="RAG searchers" name="rag_searchers" placeholder="embedding_search,keyword_search,front_page_search" value={settings.rag_searchers} onChange={onSettingChange} />
          <CheckboxField label="启用摘要 embedding 粗筛" name="rag_prefilter_enabled" checked={settings.rag_prefilter_enabled} onChange={onSettingChange} />
          <NumberField label="粗筛阈值" name="rag_prefilter_threshold" min="0" max="1" step="0.01" value={settings.rag_prefilter_threshold} onChange={onSettingChange} />
          <NumberField label="粗筛 Top K" name="rag_prefilter_top_k" min="1" step="1" value={settings.rag_prefilter_top_k} onChange={onSettingChange} />
          <NumberField label="每日保底精排数" name="rag_prefilter_min_keep" min="0" step="1" value={settings.rag_prefilter_min_keep} onChange={onSettingChange} />
          <NumberField label="每日最大精排数" name="rag_prefilter_max_keep" min="0" step="1" value={settings.rag_prefilter_max_keep} onChange={onSettingChange} />
        </SettingsSection>

        <SettingsSection
          eyebrow="Capacity & recovery"
          title="并发、缓存与补跑"
          description="限制下游请求容量，保存全文缓存，并约束失败后的历史补洞规模。"
        >
          <CheckboxField label="缓存 PDF 并提取 TXT" name="arxiv_cache_full_text" checked={settings.arxiv_cache_full_text} onChange={onSettingChange} />
          <TextField label="PDF 缓存目录" name="arxiv_pdf_dir" placeholder="./data/arxiv_pdfs" value={settings.arxiv_pdf_dir} onChange={onSettingChange} />
          <TextField label="TXT 输出目录" name="arxiv_text_dir" placeholder="./data/arxiv_text" value={settings.arxiv_text_dir} onChange={onSettingChange} />
          <NumberField label="Embedding 请求并发数" name="embedding_concurrency" min="1" step="1" value={settings.embedding_concurrency} onChange={onSettingChange} />
          <NumberField label="报告队列并发数" name="paper_report_queue_concurrency" min="1" max="8" step="1" value={settings.paper_report_queue_concurrency} onChange={onSettingChange} />
          <NumberField label="历史补洞上限" name="retry_daily_max_results" min="1" step="1" value={settings.retry_daily_max_results} onChange={onSettingChange} />
        </SettingsSection>

      </form>

      <TaskHistoryPanel {...taskHistoryProps} />
    </div>
  );
}
