import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { InlineLoader } from "./Loading.jsx";
import { useCachedApi } from "../lib/apiCache.jsx";
import { api, chooseLocalPath, postJson } from "../lib/dashboard.js";
import "../styles/OnboardingGate.css";

const PROJECT_STATUSES = [
  ["active", "进行中"],
  ["planned", "计划中"],
  ["paused", "搁置"],
  ["completed", "已完成"]
];

function shouldShowOnboarding(settings, projects) {
  if (settings?.onboarding_completed) return false;
  if (String(settings?.obsidian_vault_path || "").trim()) return false;
  const backend = String(settings?.obsidian_storage_backend || "");
  const remoteBucket = String(settings?.obsidian_remote_bucket || "").trim();
  const remoteEndpoint = String(settings?.obsidian_remote_endpoint_url || "").trim();
  const remoteAccessKey = String(settings?.obsidian_remote_access_key_id || "").trim();
  const remoteSecret = Boolean(settings?.obsidian_remote_secret_access_key_configured || settings?.obsidian_remote_secret_access_key);
  if (backend === "s3" && remoteBucket) return false;
  if (["oss", "r2"].includes(backend) && remoteBucket && remoteEndpoint && remoteAccessKey && remoteSecret) return false;
  return !projects.length;
}

export function OnboardingGate({ notify = () => {}, setStatusMessage = () => {} }) {
  const navigate = useNavigate();
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState("");
  const [mode, setMode] = useState("obsidian");
  const [obsidianForm, setObsidianForm] = useState({
    obsidian_storage_backend: "local",
    obsidian_vault_path: "",
    obsidian_remote_endpoint_url: "",
    obsidian_remote_region: "",
    obsidian_remote_bucket: "",
    obsidian_remote_prefix: "",
    obsidian_remote_output_prefix: "Research Intelligence",
    obsidian_remote_mirror_dir: "./data/obsidian_remote_vault",
    obsidian_remote_access_key_id: "",
    obsidian_remote_secret_access_key: "",
    obsidian_include_dirs: "",
    obsidian_project_center_tags: "project,center"
  });
  const [projectForm, setProjectForm] = useState({
    name: "",
    status: "active",
    keywords: "",
    raw_context: ""
  });
  const settingsQuery = useCachedApi(["settings"], () => api("/api/settings"), { refetchOnStale: false, staleTime: Infinity });
  const projectsQuery = useCachedApi(["projects"], () => api("/api/projects"), { refetchOnStale: false, staleTime: 60000 });

  useEffect(() => {
    const error = settingsQuery.error || projectsQuery.error;
    if (error) {
      setStatusMessage(error.message);
      return;
    }
    if (!settingsQuery.hasData || !projectsQuery.hasData) return;
    setVisible(shouldShowOnboarding(settingsQuery.data?.settings || {}, projectsQuery.data?.items || []));
  }, [projectsQuery.data, projectsQuery.error, projectsQuery.hasData, settingsQuery.data, settingsQuery.error, settingsQuery.hasData, setStatusMessage]);

  const completeOnboarding = useCallback(async (source, extraSettings = {}) => {
    await postJson("/api/settings", {
      ...extraSettings,
      onboarding_completed: true,
      onboarding_project_source: source
    });
    setVisible(false);
  }, []);

  const pickObsidianVault = useCallback(async () => {
    if (busy) return;
    setBusy("vault");
    setStatusMessage("正在选择 Obsidian vault...");
    try {
      const data = await chooseLocalPath({
        mode: "directory",
        title: "选择 Obsidian vault"
      });
      if (data.cancelled) {
        setStatusMessage("已取消 Obsidian 连接");
        return;
      }
      const vaultPath = String(data.path || "").trim();
      if (!vaultPath) throw new Error("未选择 Obsidian vault 路径");
      setObsidianForm((current) => ({ ...current, obsidian_vault_path: vaultPath }));
      setStatusMessage("Obsidian vault 已选择");
    } catch (error) {
      notify(error.message || "Obsidian 连接失败", {
        statusMessage: error.message || "Obsidian 连接失败",
        type: "error"
      });
    } finally {
      setBusy("");
    }
  }, [busy, notify, setStatusMessage]);

  const saveObsidianSetup = useCallback(async (event) => {
    event.preventDefault();
    if (busy) return;
    const storageBackend = String(obsidianForm.obsidian_storage_backend || "local");
    const vaultPath = String(obsidianForm.obsidian_vault_path || "").trim();
    const remoteBackend = ["oss", "s3", "r2"].includes(storageBackend);
    if (!remoteBackend && !vaultPath) {
      notify("请先选择或填写 Obsidian vault 路径。", {
        statusMessage: "缺少 Obsidian vault 路径",
        type: "warning"
      });
      return;
    }
    if (remoteBackend) {
      const endpoint = String(obsidianForm.obsidian_remote_endpoint_url || "").trim();
      const bucket = String(obsidianForm.obsidian_remote_bucket || "").trim();
      const accessKey = String(obsidianForm.obsidian_remote_access_key_id || "").trim();
      const secret = String(obsidianForm.obsidian_remote_secret_access_key || "").trim();
      if (!bucket || (["oss", "r2"].includes(storageBackend) && !endpoint) || (["oss", "r2"].includes(storageBackend) && (!accessKey || !secret))) {
        notify("请补全对象存储连接信息。", {
          statusMessage: "对象存储配置不完整",
          type: "warning"
        });
        return;
      }
    }
    setBusy("obsidian");
    setStatusMessage("正在保存 Obsidian 初始化设置...");
    try {
      const payload = {
        obsidian_storage_backend: storageBackend,
        obsidian_include_dirs: obsidianForm.obsidian_include_dirs,
        obsidian_project_center_tags: obsidianForm.obsidian_project_center_tags
      };
      if (remoteBackend) {
        Object.assign(payload, {
          obsidian_vault_path: "",
          obsidian_remote_endpoint_url: obsidianForm.obsidian_remote_endpoint_url,
          obsidian_remote_region: obsidianForm.obsidian_remote_region,
          obsidian_remote_bucket: obsidianForm.obsidian_remote_bucket,
          obsidian_remote_prefix: obsidianForm.obsidian_remote_prefix,
          obsidian_remote_output_prefix: obsidianForm.obsidian_remote_output_prefix,
          obsidian_remote_mirror_dir: obsidianForm.obsidian_remote_mirror_dir,
          obsidian_remote_access_key_id: obsidianForm.obsidian_remote_access_key_id,
          obsidian_remote_secret_access_key: obsidianForm.obsidian_remote_secret_access_key
        });
      } else {
        payload.obsidian_vault_path = vaultPath;
      }
      await completeOnboarding(remoteBackend ? "obsidian_remote" : "obsidian", payload);
      notify("Obsidian 初始化设置已保存。", {
        statusMessage: "Obsidian 初始化完成",
        type: "success"
      });
    } catch (error) {
      notify(error.message || "初始化设置保存失败", {
        statusMessage: error.message || "初始化设置保存失败",
        type: "error"
      });
    } finally {
      setBusy("");
    }
  }, [busy, completeOnboarding, notify, obsidianForm, setStatusMessage]);

  const createManualProject = useCallback(async (event) => {
    event.preventDefault();
    if (busy) return;
    const name = String(projectForm.name || "").trim();
    if (!name) {
      notify("请填写项目名称。", {
        statusMessage: "缺少项目名称",
        type: "warning"
      });
      return;
    }
    setBusy("manual");
    setStatusMessage("正在创建第一个项目...");
    try {
      const data = await postJson("/api/projects", {
        name,
        status: projectForm.status,
        keywords: projectForm.keywords,
        raw_context: projectForm.raw_context
      });
      await completeOnboarding("manual");
      notify("第一个项目已创建。", {
        statusMessage: "第一个项目已创建",
        type: "success"
      });
      if (data.project?.id) navigate(`/projects/${encodeURIComponent(String(data.project.id))}`);
    } catch (error) {
      notify(error.message || "项目创建失败", {
        statusMessage: error.message || "项目创建失败",
        type: "error"
      });
    } finally {
      setBusy("");
    }
  }, [busy, completeOnboarding, navigate, notify, projectForm, setStatusMessage]);

  if (!visible) return null;

  return (
    <div className="onboarding-backdrop" role="presentation">
      <section
        aria-labelledby="onboarding-title"
        aria-modal="true"
        className="onboarding-dialog"
        role="dialog"
      >
        <div className="onboarding-header">
          <span>初始化</span>
          <h2 id="onboarding-title">设置项目来源</h2>
          <p>把第一步配置直接完成在这里；之后仍可在设置页调整。</p>
        </div>

        <div className="onboarding-tabs" role="tablist" aria-label="项目来源">
          <button
            aria-selected={mode === "obsidian"}
            className={mode === "obsidian" ? "active" : ""}
            disabled={Boolean(busy)}
            onClick={() => setMode("obsidian")}
            role="tab"
            type="button"
          >
            连接 Obsidian
          </button>
          <button
            aria-selected={mode === "manual"}
            className={mode === "manual" ? "active" : ""}
            disabled={Boolean(busy)}
            onClick={() => setMode("manual")}
            role="tab"
            type="button"
          >
            系统内项目
          </button>
        </div>

        {mode === "obsidian" ? (
          <form className="onboarding-form" onSubmit={saveObsidianSetup}>
            <label>
              <span>存储模式</span>
              <select
                autoFocus
                value={obsidianForm.obsidian_storage_backend}
                onChange={(event) => setObsidianForm((current) => ({ ...current, obsidian_storage_backend: event.target.value }))}
              >
                <option value="local">本地 vault</option>
                <option value="oss">阿里云 OSS</option>
                <option value="s3">S3 兼容</option>
                <option value="r2">Cloudflare R2</option>
              </select>
            </label>
            {["oss", "s3", "r2"].includes(obsidianForm.obsidian_storage_backend) ? (
              <>
                <label>
                  <span>Endpoint URL</span>
                  <input
                    placeholder={obsidianForm.obsidian_storage_backend === "r2" ? "https://<account>.r2.cloudflarestorage.com" : "https://oss-cn-hangzhou.aliyuncs.com"}
                    value={obsidianForm.obsidian_remote_endpoint_url}
                    onChange={(event) => setObsidianForm((current) => ({ ...current, obsidian_remote_endpoint_url: event.target.value }))}
                  />
                </label>
                <label>
                  <span>Region</span>
                  <input
                    placeholder={obsidianForm.obsidian_storage_backend === "r2" ? "auto" : "cn-hangzhou"}
                    value={obsidianForm.obsidian_remote_region}
                    onChange={(event) => setObsidianForm((current) => ({ ...current, obsidian_remote_region: event.target.value }))}
                  />
                </label>
                <label>
                  <span>Bucket</span>
                  <input
                    placeholder="obsidian-vault"
                    value={obsidianForm.obsidian_remote_bucket}
                    onChange={(event) => setObsidianForm((current) => ({ ...current, obsidian_remote_bucket: event.target.value }))}
                  />
                </label>
                <label>
                  <span>Vault prefix</span>
                  <input
                    placeholder="vault"
                    value={obsidianForm.obsidian_remote_prefix}
                    onChange={(event) => setObsidianForm((current) => ({ ...current, obsidian_remote_prefix: event.target.value }))}
                  />
                </label>
                <label>
                  <span>系统输出前缀</span>
                  <input
                    placeholder="Research Intelligence"
                    value={obsidianForm.obsidian_remote_output_prefix}
                    onChange={(event) => setObsidianForm((current) => ({ ...current, obsidian_remote_output_prefix: event.target.value }))}
                  />
                </label>
                <label>
                  <span>本地镜像目录</span>
                  <input
                    placeholder="./data/obsidian_remote_vault"
                    value={obsidianForm.obsidian_remote_mirror_dir}
                    onChange={(event) => setObsidianForm((current) => ({ ...current, obsidian_remote_mirror_dir: event.target.value }))}
                  />
                </label>
                <label>
                  <span>Access key ID</span>
                  <input
                    placeholder="Access key ID"
                    value={obsidianForm.obsidian_remote_access_key_id}
                    onChange={(event) => setObsidianForm((current) => ({ ...current, obsidian_remote_access_key_id: event.target.value }))}
                  />
                </label>
                <label>
                  <span>Access secret</span>
                  <input
                    placeholder="Access secret"
                    type="password"
                    value={obsidianForm.obsidian_remote_secret_access_key}
                    onChange={(event) => setObsidianForm((current) => ({ ...current, obsidian_remote_secret_access_key: event.target.value }))}
                  />
                </label>
              </>
            ) : (
              <label>
                <span>Obsidian vault</span>
                <div className="path-input-row">
                  <input
                    placeholder="D:\\Obsidian\\Vault"
                    value={obsidianForm.obsidian_vault_path}
                    onChange={(event) => setObsidianForm((current) => ({ ...current, obsidian_vault_path: event.target.value }))}
                  />
                  <button disabled={Boolean(busy)} onClick={pickObsidianVault} type="button">选择</button>
                </div>
              </label>
            )}
            <label>
              <span>扫描文件夹</span>
              <input
                placeholder="Research,Papers"
                value={obsidianForm.obsidian_include_dirs}
                onChange={(event) => setObsidianForm((current) => ({ ...current, obsidian_include_dirs: event.target.value }))}
              />
            </label>
            <label>
              <span>项目中心页标签</span>
              <input
                placeholder="project,center"
                value={obsidianForm.obsidian_project_center_tags}
                onChange={(event) => setObsidianForm((current) => ({ ...current, obsidian_project_center_tags: event.target.value }))}
              />
            </label>
            <div className="onboarding-actions">
              <button className="primary" disabled={Boolean(busy)} type="submit">保存 Obsidian 设置</button>
            </div>
          </form>
        ) : (
          <form className="onboarding-form onboarding-project-form" onSubmit={createManualProject}>
            <label>
              <span>项目名称</span>
              <input
                autoFocus
                placeholder="Agentic RAG"
                value={projectForm.name}
                onChange={(event) => setProjectForm((current) => ({ ...current, name: event.target.value }))}
              />
            </label>
            <label>
              <span>状态</span>
              <select
                value={projectForm.status}
                onChange={(event) => setProjectForm((current) => ({ ...current, status: event.target.value }))}
              >
                {PROJECT_STATUSES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label>
              <span>关键词</span>
              <input
                placeholder="RAG,agent,scientific discovery"
                value={projectForm.keywords}
                onChange={(event) => setProjectForm((current) => ({ ...current, keywords: event.target.value }))}
              />
            </label>
            <label className="wide">
              <span>原始项目上下文</span>
              <textarea
                placeholder="粘贴研究问题、README、实验计划或任意自由文本。"
                rows={5}
                value={projectForm.raw_context}
                onChange={(event) => setProjectForm((current) => ({ ...current, raw_context: event.target.value }))}
              />
            </label>
            <div className="onboarding-actions">
              <button className="primary" disabled={Boolean(busy)} type="submit">创建项目</button>
            </div>
          </form>
        )}

        {busy ? (
          <div className="onboarding-busy">
            <InlineLoader label={busy === "vault" ? "正在选择路径" : busy === "obsidian" ? "正在保存 Obsidian 设置" : "正在创建项目"} />
          </div>
        ) : null}
      </section>
    </div>
  );
}
