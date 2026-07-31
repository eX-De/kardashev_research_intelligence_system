import { useTranslation } from "react-i18next";

import { csv } from "../lib/dashboard.js";
import { WorkspaceSelect } from "./WorkspaceSelect.jsx";
import "../styles/SettingsForm.css";
import "../styles/DataStorageSettingsView.css";

function SettingsSection({ eyebrow, title, description, children }) {
  return (
    <section className="settings-section data-storage-section">
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

function TextField({ label, name, placeholder, value, onChange, type = "text" }) {
  return (
    <label>
      <span>{label}</span>
      <input
        autoComplete={type === "password" ? "new-password" : undefined}
        name={name}
        placeholder={placeholder}
        type={type}
        value={type === "password" ? value || "" : csv(value)}
        onChange={(event) => onChange(name, event.target.value)}
      />
    </label>
  );
}

function PathField({ label, name, placeholder, relativeTo, value, onChange, onPickPath }) {
  const { t } = useTranslation("settings");
  return (
    <label className="path-field">
      <span>{label}</span>
      <div className="path-input-row">
        <input
          name={name}
          placeholder={placeholder}
          value={csv(value)}
          onChange={(event) => onChange(name, event.target.value)}
        />
        <button
          disabled={!onPickPath}
          type="button"
          onClick={() => onPickPath?.(name, { mode: "directory", relativeTo, title: t("data.pickPathTitle", { label }) })}
        >
          {t("data.choose")}
        </button>
      </div>
    </label>
  );
}

export function DataStorageSettingsView({
  settings = {},
  onSettingChange = () => {},
  onPickPath,
  onSubmit,
  saveStatus = "idle"
}) {
  const { t } = useTranslation("settings");
  const obsidianBackend = String(settings.obsidian_storage_backend || "local");
  const remoteObsidian = ["oss", "s3", "r2"].includes(obsidianBackend);
  const remoteSecretText = settings.obsidian_remote_secret_access_key_configured
    ? t("data.secretSaved")
    : t("data.accessSecret");

  function submitSettings(event) {
    if (onSubmit) {
      onSubmit(event);
      return;
    }
    event.preventDefault();
  }

  return (
    <div className="data-storage-settings-view">
      <header className="settings-subpage-heading">
        <div>
          <span>DATA &amp; STORAGE</span>
          <h2>{t("data.title")}</h2>
          <p>{t("data.description")}</p>
        </div>
        <em className={`settings-subpage-save-state is-${saveStatus}`} aria-live="polite">
          {t(`saveStatus.${saveStatus}`, { defaultValue: t("saveStatus.idle") })}
        </em>
      </header>

      <form className="settings-form data-storage-settings-form" onSubmit={submitSettings}>
        <SettingsSection
          eyebrow={t("data.sections.connection.eyebrow")}
          title={t("data.sections.connection.title")}
          description={t("data.sections.connection.description")}
        >
        <label className="settings-select-field">
          <span>{t("data.fields.storageMode")}</span>
          <WorkspaceSelect
            ariaLabel={t("data.fields.storageMode")}
            value={obsidianBackend}
            onChange={(value) => onSettingChange("obsidian_storage_backend", value)}
            options={[
              ["local", t("data.backends.local")],
              ["oss", t("data.backends.oss")],
              ["s3", t("data.backends.s3")],
              ["r2", "Cloudflare R2"]
            ]}
          />
        </label>

        {remoteObsidian ? (
          <>
            <TextField
              label={t("data.fields.endpointUrl")}
              name="obsidian_remote_endpoint_url"
              placeholder={obsidianBackend === "r2" ? "https://<account>.r2.cloudflarestorage.com" : "https://oss-cn-hangzhou.aliyuncs.com"}
              value={settings.obsidian_remote_endpoint_url}
              onChange={onSettingChange}
            />
            <TextField label={t("data.fields.region")} name="obsidian_remote_region" placeholder={obsidianBackend === "r2" ? "auto" : "cn-hangzhou"} value={settings.obsidian_remote_region} onChange={onSettingChange} />
            <TextField label={t("data.fields.bucket")} name="obsidian_remote_bucket" placeholder="obsidian-vault" value={settings.obsidian_remote_bucket} onChange={onSettingChange} />
            <TextField label={t("data.fields.vaultPrefix")} name="obsidian_remote_prefix" placeholder="vault" value={settings.obsidian_remote_prefix} onChange={onSettingChange} />
            <TextField label={t("data.fields.outputPrefix")} name="obsidian_remote_output_prefix" placeholder="Research Intelligence" value={settings.obsidian_remote_output_prefix} onChange={onSettingChange} />
            <TextField label={t("data.fields.localMirror")} name="obsidian_remote_mirror_dir" placeholder="./data/obsidian_remote_vault" value={settings.obsidian_remote_mirror_dir} onChange={onSettingChange} />
            <TextField label={t("data.fields.accessKeyId")} name="obsidian_remote_access_key_id" placeholder="AKIA..." value={settings.obsidian_remote_access_key_id} onChange={onSettingChange} />
            <TextField label={t("data.fields.accessSecret")} name="obsidian_remote_secret_access_key" placeholder={remoteSecretText} type="password" value={settings.obsidian_remote_secret_access_key} onChange={onSettingChange} />
          </>
        ) : (
          <PathField label={t("data.fields.optionalVault")} name="obsidian_vault_path" placeholder="D:\\Obsidian\\Vault" value={settings.obsidian_vault_path} onChange={onSettingChange} onPickPath={onPickPath} />
        )}
        </SettingsSection>

        <SettingsSection
          eyebrow={t("data.sections.layout.eyebrow")}
          title={t("data.sections.layout.title")}
          description={t("data.sections.layout.description")}
        >
        <TextField label={t("data.fields.includeDirectories")} name="obsidian_include_dirs" placeholder="Research,Papers" value={settings.obsidian_include_dirs} onChange={onSettingChange} />
        <TextField label={t("data.fields.includeTags")} name="obsidian_include_tags" placeholder="research,paper,direction" value={settings.obsidian_include_tags} onChange={onSettingChange} />
        <TextField label={t("data.fields.projectCenterTags")} name="obsidian_project_center_tags" placeholder="project,center" value={settings.obsidian_project_center_tags} onChange={onSettingChange} />

        {!remoteObsidian ? (
          <>
            <TextField label={t("data.fields.cliCommand")} name="obsidian_cli_command" placeholder="obsidian" value={settings.obsidian_cli_command} onChange={onSettingChange} />
            <PathField label={t("data.fields.paperRepository")} name="obsidian_paper_repository_dir" placeholder={t("data.placeholders.paperRepository")} relativeTo="obsidian_vault" value={settings.obsidian_paper_repository_dir} onChange={onSettingChange} onPickPath={onPickPath} />
            <PathField label={t("data.fields.paperAttachments")} name="obsidian_paper_attachment_dir" placeholder={t("data.placeholders.paperAttachments")} relativeTo="obsidian_vault" value={settings.obsidian_paper_attachment_dir} onChange={onSettingChange} onPickPath={onPickPath} />
            <TextField label={t("data.fields.projectPaperList")} name="obsidian_project_paper_list_name" placeholder={t("data.placeholders.projectPaperList")} value={settings.obsidian_project_paper_list_name} onChange={onSettingChange} />
          </>
        ) : (
          <p className="data-storage-remote-note settings-grid-wide">
            {t("data.remoteNote")}
          </p>
        )}
        </SettingsSection>

      </form>
    </div>
  );
}
