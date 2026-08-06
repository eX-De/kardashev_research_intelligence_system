import { useEffect, useState } from "react";
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

function GroupLimitControl({ group, onChange, t }) {
  const [value, setValue] = useState(group.max_running ?? "");
  useEffect(() => setValue(group.max_running ?? ""), [group.max_running]);
  const unlimited = group.max_running === null;

  function commit() {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed >= 1) onChange(parsed);
    else setValue(group.max_running ?? "");
  }

  return (
    <div className="worker-limit-control">
      <label className="worker-unlimited-toggle">
        <input type="checkbox" checked={unlimited} onChange={(event) => onChange(event.target.checked ? null : group.default_max_running)} />
        <span>{t("daily.workerConcurrency.unlimited")}</span>
      </label>
      <input
        aria-label={t("daily.workerConcurrency.effective")}
        disabled={unlimited}
        min="1"
        type="number"
        value={unlimited ? "" : value}
        onBlur={commit}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
      />
    </div>
  );
}

function WorkerConcurrencyCard({ settings, workerStatus, conflict, applyState, onChange, onReload, t }) {
  const policy = settings.worker_concurrency;
  if (!policy?.groups) return null;
  const groups = Object.entries(policy.groups);
  const editableGroups = groups.filter(([, group]) => group.editable);
  const immutableGroups = groups.filter(([, group]) => !group.editable);
  const occupancy = workerStatus?.group_occupancy || {};

  function updateField(field, value) {
    onChange((current) => ({ ...current, [field]: value }));
  }

  function updateGroup(name, maxRunning) {
    onChange((current) => ({
      ...current,
      groups: { ...current.groups, [name]: { ...current.groups[name], max_running: maxRunning } }
    }));
  }

  return (
    <section className="settings-section daily-tasks-settings-section worker-concurrency-card">
      <div className="settings-section-head">
        <div><span>{t("daily.workerConcurrency.eyebrow")}</span><h3>{t("daily.workerConcurrency.title")}</h3></div>
        <p>{t("daily.workerConcurrency.description")}</p>
      </div>
      <div className="worker-pool-status" data-state={workerStatus?.pool?.state || "unknown"}>
        <span>{t("daily.workerConcurrency.desired", { count: policy.worker_process_count })}</span>
        <span>{t("daily.workerConcurrency.online", { count: workerStatus?.pool?.actual_processes ?? 0 })}</span>
        <span>{t("daily.workerConcurrency.draining", { count: workerStatus?.pool?.draining_processes ?? 0 })}</span>
        <strong>{t(`daily.workerConcurrency.applyState.${applyState}`, { defaultValue: applyState })}</strong>
      </div>
      {conflict ? (
        <div className="worker-concurrency-conflict" role="alert">
          <span>{t("daily.workerConcurrency.conflict", { revision: conflict.revision })}</span>
          <button type="button" onClick={onReload}>{t("daily.workerConcurrency.reload")}</button>
        </div>
      ) : null}
      <div className="settings-field-grid worker-capacity-fields">
        <NumberField label={t("daily.workerConcurrency.fields.workerProcesses")} min="1" max="16" value={policy.worker_process_count} onChange={(_, value) => updateField("worker_process_count", value)} />
        <NumberField label={t("daily.fields.globalLlmConcurrency")} min="1" max="64" value={policy.global_llm_request_concurrency} onChange={(_, value) => updateField("global_llm_request_concurrency", value)} />
        <NumberField label={t("daily.fields.globalEmbeddingConcurrency")} min="1" max="64" value={policy.global_embedding_request_concurrency} onChange={(_, value) => updateField("global_embedding_request_concurrency", value)} />
        <NumberField label={t("daily.fields.embeddingConcurrency")} min="1" max="32" value={policy.embedding_concurrency} onChange={(_, value) => updateField("embedding_concurrency", value)} />
        <NumberField label={t("daily.fields.judgmentConcurrency")} min="1" max="8" value={policy.project_judgment_concurrency} onChange={(_, value) => updateField("project_judgment_concurrency", value)} />
        <NumberField label={t("daily.workerConcurrency.fields.projectProfile")} min="1" max="8" value={policy.project_chat_profile_concurrency} onChange={(_, value) => updateField("project_chat_profile_concurrency", value)} />
      </div>
      <p className="worker-scale-note">{t("daily.workerConcurrency.scaleDownNote")}</p>
      <div className="worker-group-table-wrap">
        <table className="worker-group-table">
          <thead><tr><th>{t("daily.workerConcurrency.group")}</th><th>{t("daily.workerConcurrency.default")}</th><th>{t("daily.workerConcurrency.effective")}</th><th>{t("daily.workerConcurrency.running")}</th></tr></thead>
          <tbody>{editableGroups.map(([name, group]) => (
            <tr key={name}>
              <td><strong>{name}</strong><small>{t(`daily.workerConcurrency.groupJobs.${name}`, { defaultValue: name })}</small></td>
              <td>{group.default_max_running}</td>
              <td><GroupLimitControl group={group} onChange={(value) => updateGroup(name, value)} t={t} /></td>
              <td>{occupancy[name]?.running || 0}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <div className="worker-invariant-notes">
        {immutableGroups.map(([name, group]) => (
          <p key={name}><strong>{name}</strong> — {name === "paper-report" ? t("daily.workerConcurrency.paperReport") : t("daily.workerConcurrency.immutable", { limit: group.max_running })}</p>
        ))}
      </div>
    </section>
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
  taskHistoryProps = {},
  workerStatus = {},
  concurrencyConflict = null,
  capacityApplyState = "idle",
  onWorkerConcurrencyChange = () => {},
  onReloadWorkerConcurrency = () => {}
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
          <NumberField label={t("daily.fields.retryLimit")} name="retry_daily_max_results" min="1" step="1" value={settings.retry_daily_max_results} onChange={onSettingChange} />
        </SettingsSection>

        <WorkerConcurrencyCard
          settings={settings}
          workerStatus={workerStatus}
          conflict={concurrencyConflict}
          applyState={capacityApplyState}
          onChange={onWorkerConcurrencyChange}
          onReload={onReloadWorkerConcurrency}
          t={t}
        />

      </form>

      <TaskHistoryPanel {...taskHistoryProps} />
    </div>
  );
}
