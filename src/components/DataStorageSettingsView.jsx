import { csv } from "../lib/dashboard.js";
import { WorkspaceSelect } from "./WorkspaceSelect.jsx";
import "../styles/SettingsForm.css";
import "../styles/DataStorageSettingsView.css";

const SAVE_STATUS_LABELS = {
  idle: "未修改",
  dirty: "保存中",
  saving: "保存中",
  saved: "已保存",
  error: "保存失败"
};

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
          onClick={() => onPickPath?.(name, { mode: "directory", relativeTo, title: `选择${label}` })}
        >
          选择
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
  const obsidianBackend = String(settings.obsidian_storage_backend || "local");
  const remoteObsidian = ["oss", "s3", "r2"].includes(obsidianBackend);
  const remoteSecretText = settings.obsidian_remote_secret_access_key_configured
    ? "Secret 已保存；留空不修改。"
    : "Access secret";

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
          <h2>数据与存储</h2>
          <p>管理 Obsidian 连接、知识库扫描范围，以及论文和附件的保存位置。</p>
        </div>
        <em className={`settings-subpage-save-state is-${saveStatus}`} aria-live="polite">
          {SAVE_STATUS_LABELS[saveStatus] || SAVE_STATUS_LABELS.idle}
        </em>
      </header>

      <form className="settings-form data-storage-settings-form" onSubmit={submitSettings}>
        <SettingsSection
          eyebrow="Storage connection"
          title="Obsidian 存储连接"
          description="选择本地 vault 或对象存储。系统内知识库不依赖 Obsidian，只有配置连接后才启用相关导入和导出。"
        >
        <label className="settings-select-field">
          <span>Obsidian 存储模式</span>
          <WorkspaceSelect
            ariaLabel="Obsidian 存储模式"
            value={obsidianBackend}
            onChange={(value) => onSettingChange("obsidian_storage_backend", value)}
            options={[
              ["local", "本地 vault"],
              ["oss", "阿里云 OSS"],
              ["s3", "S3 兼容"],
              ["r2", "Cloudflare R2"]
            ]}
          />
        </label>

        {remoteObsidian ? (
          <>
            <TextField
              label="Endpoint URL"
              name="obsidian_remote_endpoint_url"
              placeholder={obsidianBackend === "r2" ? "https://<account>.r2.cloudflarestorage.com" : "https://oss-cn-hangzhou.aliyuncs.com"}
              value={settings.obsidian_remote_endpoint_url}
              onChange={onSettingChange}
            />
            <TextField label="Region" name="obsidian_remote_region" placeholder={obsidianBackend === "r2" ? "auto" : "cn-hangzhou"} value={settings.obsidian_remote_region} onChange={onSettingChange} />
            <TextField label="Bucket" name="obsidian_remote_bucket" placeholder="obsidian-vault" value={settings.obsidian_remote_bucket} onChange={onSettingChange} />
            <TextField label="Vault prefix" name="obsidian_remote_prefix" placeholder="vault" value={settings.obsidian_remote_prefix} onChange={onSettingChange} />
            <TextField label="系统输出前缀" name="obsidian_remote_output_prefix" placeholder="Research Intelligence" value={settings.obsidian_remote_output_prefix} onChange={onSettingChange} />
            <TextField label="本地镜像目录" name="obsidian_remote_mirror_dir" placeholder="./data/obsidian_remote_vault" value={settings.obsidian_remote_mirror_dir} onChange={onSettingChange} />
            <TextField label="Access key ID" name="obsidian_remote_access_key_id" placeholder="AKIA..." value={settings.obsidian_remote_access_key_id} onChange={onSettingChange} />
            <TextField label="Access secret" name="obsidian_remote_secret_access_key" placeholder={remoteSecretText} type="password" value={settings.obsidian_remote_secret_access_key} onChange={onSettingChange} />
          </>
        ) : (
          <PathField label="可选 Obsidian vault 路径" name="obsidian_vault_path" placeholder="D:\\Obsidian\\Vault" value={settings.obsidian_vault_path} onChange={onSettingChange} onPickPath={onPickPath} />
        )}
        </SettingsSection>

        <SettingsSection
          eyebrow="Vault layout"
          title="知识库范围与目录"
          description="定义需要扫描的内容，以及论文、附件和项目索引在 Obsidian 中的保存位置。"
        >
        <TextField label="Obsidian 扫描文件夹" name="obsidian_include_dirs" placeholder="Research,Papers" value={settings.obsidian_include_dirs} onChange={onSettingChange} />
        <TextField label="Obsidian 纳入标签" name="obsidian_include_tags" placeholder="research,paper,direction" value={settings.obsidian_include_tags} onChange={onSettingChange} />
        <TextField label="Obsidian 项目中心页标签" name="obsidian_project_center_tags" placeholder="project,center" value={settings.obsidian_project_center_tags} onChange={onSettingChange} />

        {!remoteObsidian ? (
          <>
            <TextField label="Obsidian CLI 命令（可选）" name="obsidian_cli_command" placeholder="obsidian" value={settings.obsidian_cli_command} onChange={onSettingChange} />
            <PathField label="Obsidian 论文仓库目录" name="obsidian_paper_repository_dir" placeholder="人工智能/论文仓库" relativeTo="obsidian_vault" value={settings.obsidian_paper_repository_dir} onChange={onSettingChange} onPickPath={onPickPath} />
            <PathField label="Obsidian 论文附件目录" name="obsidian_paper_attachment_dir" placeholder="人工智能/论文仓库/附件" relativeTo="obsidian_vault" value={settings.obsidian_paper_attachment_dir} onChange={onSettingChange} onPickPath={onPickPath} />
            <TextField label="Obsidian 项目论文列表文件名" name="obsidian_project_paper_list_name" placeholder="论文列表.md" value={settings.obsidian_project_paper_list_name} onChange={onSettingChange} />
          </>
        ) : (
          <p className="data-storage-remote-note settings-grid-wide">
            远程模式下，论文仓库和附件沿用对象存储前缀，不需要配置本地 vault 相对目录。
          </p>
        )}
        </SettingsSection>

      </form>
    </div>
  );
}
