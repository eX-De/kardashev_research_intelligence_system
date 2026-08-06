import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { csv } from "../lib/dashboard.js";
import { TaskControlPanel } from "./TaskControlPanel.jsx";
import { TaskHistoryPanel } from "./TaskHistoryPanel.jsx";
import { LocalizedPromptEditor } from "./LocalizedPromptEditor.jsx";
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

function CapacityField({ label, hint = "", max, unit, value, onChange }) {
  return (
    <label className="worker-capacity-field">
      <span className="worker-capacity-field-head">
        <strong>{label}</strong>
        <small>1–{max}</small>
      </span>
      <span className="worker-capacity-input">
        <input
          max={max}
          min="1"
          type="number"
          value={value ?? ""}
          onChange={(event) => onChange(event.target.value)}
        />
        <em>{unit}</em>
      </span>
      {hint ? <small className="worker-capacity-field-note">{hint}</small> : null}
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
    <div className={`worker-limit-control ${unlimited ? "is-unlimited" : ""}`}>
      <label className="worker-unlimited-toggle">
        <input type="checkbox" checked={unlimited} onChange={(event) => onChange(event.target.checked ? null : group.default_max_running)} />
        <span className="worker-toggle-track" aria-hidden="true"><i /></span>
        <span>{t("daily.workerConcurrency.unlimited")}</span>
      </label>
      <span className="worker-limit-input">
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
        <em aria-hidden="true">{unlimited ? "∞" : t("daily.workerConcurrency.slotUnit")}</em>
      </span>
    </div>
  );
}

const DAILY_EDITABLE_GROUPS = new Set();
const DAILY_INVARIANT_GROUPS = new Set(["arxiv", "ingest", "daily"]);
const READER_REPORT_EDITABLE_GROUPS = new Set(["reader-import", "paper-report"]);

function WorkerGroupCard({ name, group, running, onChange, t }) {
  return (
    <article className="worker-group-card">
      <div className="worker-group-card-head">
        <div>
          <strong>{name}</strong>
          <p>{t(`daily.workerConcurrency.groupJobs.${name}`, { defaultValue: name })}</p>
        </div>
        <span className={running > 0 ? "is-running" : ""}>
          <strong>{running}</strong>
          {t("daily.workerConcurrency.running")}
        </span>
      </div>
      <div className="worker-group-card-foot">
        <span>{t("daily.workerConcurrency.default")} <strong>{group.default_max_running}</strong></span>
        <GroupLimitControl group={group} onChange={onChange} t={t} />
      </div>
    </article>
  );
}

function WorkerGuardrailCard({ name, group, t }) {
  return (
    <article>
      <span className="worker-guardrail-mark" aria-hidden="true">●</span>
      <div>
        <strong>{name}</strong>
        <p>
          {t(`daily.workerConcurrency.groupJobs.${name}`, { defaultValue: name })}
          {" · "}
          {t(`daily.workerConcurrency.groupRules.${name}`, { defaultValue: t("daily.workerConcurrency.immutable", { limit: group.max_running }) })}
        </p>
      </div>
      <em>{group.max_running}</em>
    </article>
  );
}

function WorkerWorkflowPanel({
  description,
  editableGroups,
  eyebrow,
  immutableGroups,
  localControl,
  occupancy,
  onGroupChange,
  title,
  t
}) {
  return (
    <section className="worker-workflow-panel">
      <div className="worker-subsection-heading">
        <div><span>{eyebrow}</span><h4>{title}</h4></div>
        <p>{description}</p>
      </div>
      {localControl ? (
        <div className="worker-workflow-block worker-workflow-local">
          <div className="worker-workflow-block-head">
            <strong>{t("daily.workerConcurrency.internalParallelism")}</strong>
            <span>{t("daily.workerConcurrency.localLimit")}</span>
          </div>
          <div className="worker-workflow-local-fields">{localControl}</div>
        </div>
      ) : null}
      {editableGroups.length ? (
        <div className="worker-workflow-block">
          <div className="worker-workflow-block-head">
            <strong>{t("daily.workerConcurrency.taskCapacity")}</strong>
            <span>{t("daily.workerConcurrency.editableCount", { count: editableGroups.length })}</span>
          </div>
          <div className="worker-group-grid">
            {editableGroups.map(([name, group]) => (
              <WorkerGroupCard
                group={group}
                key={name}
                name={name}
                onChange={(value) => onGroupChange(name, value)}
                running={occupancy[name]?.running || 0}
                t={t}
              />
            ))}
          </div>
        </div>
      ) : null}
      {immutableGroups.length ? (
        <div className="worker-workflow-block worker-workflow-fixed">
          <div className="worker-workflow-block-head">
            <strong>{t("daily.workerConcurrency.fixedRules")}</strong>
            <span>{t("daily.workerConcurrency.fixedCount", { count: immutableGroups.length })}</span>
          </div>
          <div className="worker-guardrail-list">
            {immutableGroups.map(([name, group]) => <WorkerGuardrailCard group={group} key={name} name={name} t={t} />)}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function WorkerConcurrencyCard({ settings, workerStatus, conflict, applyState, onChange, onReload, t }) {
  const policy = settings.worker_concurrency;
  if (!policy?.groups) return null;
  const groups = Object.entries(policy.groups);
  const editableGroups = groups.filter(([, group]) => group.editable);
  const immutableGroups = groups.filter(([, group]) => !group.editable);
  const dailyEditableGroups = editableGroups.filter(([name]) => DAILY_EDITABLE_GROUPS.has(name));
  const readerReportEditableGroups = editableGroups.filter(([name]) => READER_REPORT_EDITABLE_GROUPS.has(name));
  const indexEditableGroups = editableGroups.filter(([name]) => !DAILY_EDITABLE_GROUPS.has(name) && !READER_REPORT_EDITABLE_GROUPS.has(name));
  const dailyImmutableGroups = immutableGroups.filter(([name]) => DAILY_INVARIANT_GROUPS.has(name));
  const indexImmutableGroups = immutableGroups.filter(([name]) => !DAILY_INVARIANT_GROUPS.has(name));
  const occupancy = workerStatus?.group_occupancy || {};
  const poolState = workerStatus?.pool?.state || "unknown";
  const actualProcesses = workerStatus?.pool?.actual_processes ?? 0;
  const drainingProcesses = workerStatus?.pool?.draining_processes ?? 0;

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
      <div className="worker-concurrency-workspace">
        <div className="worker-pool-overview" data-state={poolState}>
          <div className="worker-pool-heading">
            <span className="worker-pool-indicator" aria-hidden="true"><i /></span>
            <div>
              <strong>{t("daily.workerConcurrency.poolTitle")}</strong>
              <span>{t(`daily.workerConcurrency.poolState.${poolState}`, { defaultValue: poolState })}</span>
            </div>
          </div>
          <div className="worker-pool-metrics">
            <div><strong>{policy.worker_process_count}</strong><span>{t("daily.workerConcurrency.desiredLabel")}</span></div>
            <div><strong>{actualProcesses}</strong><span>{t("daily.workerConcurrency.onlineLabel")}</span></div>
            <div><strong>{drainingProcesses}</strong><span>{t("daily.workerConcurrency.drainingLabel")}</span></div>
          </div>
          <strong className={`worker-apply-state is-${applyState}`}>
            <i aria-hidden="true" />
            {t(`daily.workerConcurrency.applyState.${applyState}`, { defaultValue: applyState })}
          </strong>
        </div>

        {conflict ? (
          <div className="worker-concurrency-conflict" role="alert">
            <span>{t("daily.workerConcurrency.conflict", { revision: conflict.revision })}</span>
            <button type="button" onClick={onReload}>{t("daily.workerConcurrency.reload")}</button>
          </div>
        ) : null}

        <section className="worker-capacity-panel">
          <div className="worker-subsection-heading">
            <div><span>{t("daily.workerConcurrency.coreEyebrow")}</span><h4>{t("daily.workerConcurrency.coreTitle")}</h4></div>
            <p>{t("daily.workerConcurrency.coreDescription")}</p>
          </div>
          <div className="worker-capacity-fields">
            <CapacityField label={t("daily.workerConcurrency.fields.workerProcesses")} max="16" unit={t("daily.workerConcurrency.processUnit")} value={policy.worker_process_count} onChange={(value) => updateField("worker_process_count", value)} />
            <CapacityField label={t("daily.fields.globalLlmConcurrency")} max="64" unit={t("daily.workerConcurrency.slotUnit")} value={policy.global_llm_request_concurrency} onChange={(value) => updateField("global_llm_request_concurrency", value)} />
            <CapacityField label={t("daily.fields.globalEmbeddingConcurrency")} max="64" unit={t("daily.workerConcurrency.slotUnit")} value={policy.global_embedding_request_concurrency} onChange={(value) => updateField("global_embedding_request_concurrency", value)} />
          </div>
        </section>

        <WorkerWorkflowPanel
          description={t("daily.workerConcurrency.dailyDescription")}
          editableGroups={dailyEditableGroups}
          eyebrow={t("daily.workerConcurrency.dailyEyebrow")}
          immutableGroups={dailyImmutableGroups}
          localControl={<CapacityField hint={t("daily.workerConcurrency.judgmentHint")} label={t("daily.fields.judgmentConcurrency")} max="8" unit={t("daily.workerConcurrency.slotUnit")} value={policy.project_judgment_concurrency} onChange={(value) => updateField("project_judgment_concurrency", value)} />}
          occupancy={occupancy}
          onGroupChange={updateGroup}
          title={t("daily.workerConcurrency.dailyTitle")}
          t={t}
        />

        <WorkerWorkflowPanel
          description={t("daily.workerConcurrency.indexDescription")}
          editableGroups={indexEditableGroups}
          eyebrow={t("daily.workerConcurrency.indexEyebrow")}
          immutableGroups={indexImmutableGroups}
          localControl={<CapacityField hint={t("daily.workerConcurrency.embeddingHint")} label={t("daily.fields.embeddingConcurrency")} max="32" unit={t("daily.workerConcurrency.slotUnit")} value={policy.embedding_concurrency} onChange={(value) => updateField("embedding_concurrency", value)} />}
          occupancy={occupancy}
          onGroupChange={updateGroup}
          title={t("daily.workerConcurrency.indexTitle")}
          t={t}
        />

        <WorkerWorkflowPanel
          description={t("daily.workerConcurrency.readerReportDescription")}
          editableGroups={readerReportEditableGroups}
          eyebrow={t("daily.workerConcurrency.readerReportEyebrow")}
          immutableGroups={[]}
          occupancy={occupancy}
          onGroupChange={updateGroup}
          title={t("daily.workerConcurrency.readerReportTitle")}
          t={t}
        />

        <p className="worker-scale-note"><i aria-hidden="true">i</i>{t("daily.workerConcurrency.scaleDownNote")}</p>
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

        <SettingsSection
          eyebrow={t("daily.sections.judgmentPrompt.eyebrow")}
          title={t("daily.sections.judgmentPrompt.title")}
          description={t("daily.sections.judgmentPrompt.description")}
        >
          <LocalizedPromptEditor
            customPromptField="project_judgment_custom_prompt"
            defaultsField="project_judgment_prompt_defaults"
            editorId="project-judgment-prompt"
            localeField="project_judgment_prompt_locale"
            modeField="project_judgment_prompt_mode"
            onSettingChange={onSettingChange}
            settings={settings}
            translationPrefix="daily.judgmentPrompt"
          />
        </SettingsSection>

      </form>

      <TaskHistoryPanel {...taskHistoryProps} />
    </div>
  );
}
