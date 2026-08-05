import { useTranslation } from "react-i18next";

import { csv } from "../lib/dashboard.js";
import { TaskControlPanel } from "./TaskControlPanel.jsx";
import { TaskHistoryPanel } from "./TaskHistoryPanel.jsx";
import "../styles/SettingsForm.css";
import "../styles/DailyTasksSettingsView.css";

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
  const { t } = useTranslation("settings");

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
          <span>{t("daily.eyebrow")}</span>
          <h2>{t("daily.title")}</h2>
          <p>{t("daily.description")}</p>
        </div>
        <em className={`settings-subpage-save-state is-${saveStatus}`} aria-live="polite">
          {t(`saveStatus.${saveStatus}`, { defaultValue: t("saveStatus.idle") })}
        </em>
      </header>

      {taskControlProps ? <TaskControlPanel {...taskControlProps} /> : null}

      <form className="settings-form daily-tasks-settings-form" onSubmit={submitSettings}>
        <SettingsSection
          eyebrow={t("daily.sections.schedule.eyebrow")}
          title={t("daily.sections.schedule.title")}
          description={t("daily.sections.schedule.description")}
        >
          <label>
            <span>{t("daily.fields.schedulerRunTime")}</span>
            <input
              name="scheduler_run_time"
              type="time"
              value={settings.scheduler_run_time || ""}
              onChange={(event) => onSettingChange("scheduler_run_time", event.target.value)}
            />
          </label>
          <NumberField label={t("daily.fields.schedulerInterval")} name="scheduler_interval_hours" min="1" step="1" value={settings.scheduler_interval_hours} onChange={onSettingChange} />
          <TextField label={t("daily.fields.arxivCategories")} name="arxiv_categories" placeholder="cs.AI,cs.CL,cs.IR" value={settings.arxiv_categories} onChange={onSettingChange} />
          <NumberField label={t("daily.fields.lookbackDays")} name="arxiv_daily_lookback_days" min="1" step="1" value={settings.arxiv_daily_lookback_days} onChange={onSettingChange} />
          <NumberField label={t("daily.fields.maxResults")} name="arxiv_max_results" min="1" step="1" value={settings.arxiv_max_results} onChange={onSettingChange} />
          <NumberField label={t("daily.fields.requestInterval")} name="arxiv_request_interval_seconds" min="3" step="0.5" value={settings.arxiv_request_interval_seconds} onChange={onSettingChange} />
        </SettingsSection>

        <SettingsSection
          eyebrow={t("daily.sections.retrieval.eyebrow")}
          title={t("daily.sections.retrieval.title")}
          description={t("daily.sections.retrieval.description")}
        >
          <NumberField label={t("daily.fields.ragThreshold")} name="rag_score_threshold" min="0" max="1" step="0.01" value={settings.rag_score_threshold} onChange={onSettingChange} />
          <NumberField label={t("daily.fields.ragTopK")} name="rag_top_k" min="1" step="1" value={settings.rag_top_k} onChange={onSettingChange} />
          <TextField label={t("daily.fields.ragSearchers")} name="rag_searchers" placeholder="embedding_search,keyword_search,front_page_search" value={settings.rag_searchers} onChange={onSettingChange} />
          <CheckboxField label={t("daily.fields.prefilterEnabled")} name="rag_prefilter_enabled" checked={settings.rag_prefilter_enabled} onChange={onSettingChange} />
          <NumberField label={t("daily.fields.prefilterThreshold")} name="rag_prefilter_threshold" min="0" max="1" step="0.01" value={settings.rag_prefilter_threshold} onChange={onSettingChange} />
          <NumberField label={t("daily.fields.prefilterTopK")} name="rag_prefilter_top_k" min="1" step="1" value={settings.rag_prefilter_top_k} onChange={onSettingChange} />
          <NumberField label={t("daily.fields.prefilterMin")} name="rag_prefilter_min_keep" min="0" step="1" value={settings.rag_prefilter_min_keep} onChange={onSettingChange} />
          <NumberField label={t("daily.fields.prefilterMax")} name="rag_prefilter_max_keep" min="0" step="1" value={settings.rag_prefilter_max_keep} onChange={onSettingChange} />
        </SettingsSection>

        <SettingsSection
          eyebrow={t("daily.sections.capacity.eyebrow")}
          title={t("daily.sections.capacity.title")}
          description={t("daily.sections.capacity.description")}
        >
          <CheckboxField label={t("daily.fields.cacheFullText")} name="arxiv_cache_full_text" checked={settings.arxiv_cache_full_text} onChange={onSettingChange} />
          <TextField label={t("daily.fields.pdfDirectory")} name="arxiv_pdf_dir" placeholder="./data/arxiv_pdfs" value={settings.arxiv_pdf_dir} onChange={onSettingChange} />
          <TextField label={t("daily.fields.txtDirectory")} name="arxiv_text_dir" placeholder="./data/arxiv_text" value={settings.arxiv_text_dir} onChange={onSettingChange} />
          <NumberField label={t("daily.fields.globalLlmConcurrency")} name="global_llm_request_concurrency" min="1" step="1" value={settings.global_llm_request_concurrency ?? 4} onChange={onSettingChange} />
          <NumberField label={t("daily.fields.globalEmbeddingConcurrency")} name="global_embedding_request_concurrency" min="1" step="1" value={settings.global_embedding_request_concurrency ?? 4} onChange={onSettingChange} />
          <NumberField label={t("daily.fields.embeddingConcurrency")} name="embedding_concurrency" min="1" step="1" value={settings.embedding_concurrency} onChange={onSettingChange} />
          <NumberField label={t("daily.fields.judgmentConcurrency")} name="project_judgment_concurrency" min="1" max="8" step="1" value={settings.project_judgment_concurrency ?? 3} onChange={onSettingChange} />
          <NumberField label={t("daily.fields.retryLimit")} name="retry_daily_max_results" min="1" step="1" value={settings.retry_daily_max_results} onChange={onSettingChange} />
        </SettingsSection>

      </form>

      <TaskHistoryPanel {...taskHistoryProps} />
    </div>
  );
}
