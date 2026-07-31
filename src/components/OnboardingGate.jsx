import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { InlineLoader } from "./Loading.jsx";
import { useCachedApi } from "../lib/apiCache.jsx";
import { api, chooseLocalPath, postJson } from "../lib/dashboard.js";
import "../styles/OnboardingGate.css";

const PROJECT_STATUSES = ["active", "planned", "paused", "completed"];

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
  const { t } = useTranslation(["shell", "common"]);
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
    setStatusMessage(t("onboarding.status.selectingVault"));
    try {
      const data = await chooseLocalPath({
        mode: "directory",
        title: t("onboarding.chooseVault")
      });
      if (data.cancelled) {
        setStatusMessage(t("onboarding.status.cancelled"));
        return;
      }
      const vaultPath = String(data.path || "").trim();
      if (!vaultPath) throw new Error(t("onboarding.errors.noVault"));
      setObsidianForm((current) => ({ ...current, obsidian_vault_path: vaultPath }));
      setStatusMessage(t("onboarding.status.vaultSelected"));
    } catch (error) {
      notify(error.message || t("onboarding.errors.connection"), {
        statusMessage: error.message || t("onboarding.errors.connection"),
        type: "error"
      });
    } finally {
      setBusy("");
    }
  }, [busy, notify, setStatusMessage, t]);

  const saveObsidianSetup = useCallback(async (event) => {
    event.preventDefault();
    if (busy) return;
    const storageBackend = String(obsidianForm.obsidian_storage_backend || "local");
    const vaultPath = String(obsidianForm.obsidian_vault_path || "").trim();
    const remoteBackend = ["oss", "s3", "r2"].includes(storageBackend);
    if (!remoteBackend && !vaultPath) {
      notify(t("onboarding.errors.vaultRequired"), {
        statusMessage: t("onboarding.errors.missingVault"),
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
        notify(t("onboarding.errors.remoteRequired"), {
          statusMessage: t("onboarding.errors.remoteIncomplete"),
          type: "warning"
        });
        return;
      }
    }
    setBusy("obsidian");
    setStatusMessage(t("onboarding.status.saving"));
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
      notify(t("onboarding.saved"), {
        statusMessage: t("onboarding.status.complete"),
        type: "success"
      });
    } catch (error) {
      notify(error.message || t("onboarding.errors.save"), {
        statusMessage: error.message || t("onboarding.errors.save"),
        type: "error"
      });
    } finally {
      setBusy("");
    }
  }, [busy, completeOnboarding, notify, obsidianForm, setStatusMessage, t]);

  const createManualProject = useCallback(async (event) => {
    event.preventDefault();
    if (busy) return;
    const name = String(projectForm.name || "").trim();
    if (!name) {
      notify(t("onboarding.errors.projectNameRequired"), {
        statusMessage: t("onboarding.errors.missingProjectName"),
        type: "warning"
      });
      return;
    }
    setBusy("manual");
    setStatusMessage(t("onboarding.status.creatingProject"));
    try {
      const data = await postJson("/api/projects", {
        name,
        status: projectForm.status,
        keywords: projectForm.keywords,
        raw_context: projectForm.raw_context
      });
      await completeOnboarding("manual");
      notify(t("onboarding.projectCreated"), {
        statusMessage: t("onboarding.status.projectCreated"),
        type: "success"
      });
      if (data.project?.id) navigate(`/projects/${encodeURIComponent(String(data.project.id))}`);
    } catch (error) {
      notify(error.message || t("onboarding.errors.projectCreate"), {
        statusMessage: error.message || t("onboarding.errors.projectCreate"),
        type: "error"
      });
    } finally {
      setBusy("");
    }
  }, [busy, completeOnboarding, navigate, notify, projectForm, setStatusMessage, t]);

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
          <span>{t("onboarding.eyebrow")}</span>
          <h2 id="onboarding-title">{t("onboarding.title")}</h2>
          <p>{t("onboarding.description")}</p>
        </div>

        <div className="onboarding-tabs" role="tablist" aria-label={t("onboarding.source")}>
          <button
            aria-selected={mode === "obsidian"}
            className={mode === "obsidian" ? "active" : ""}
            disabled={Boolean(busy)}
            onClick={() => setMode("obsidian")}
            role="tab"
            type="button"
          >
            {t("onboarding.connectObsidian")}
          </button>
          <button
            aria-selected={mode === "manual"}
            className={mode === "manual" ? "active" : ""}
            disabled={Boolean(busy)}
            onClick={() => setMode("manual")}
            role="tab"
            type="button"
          >
            {t("onboarding.manualProject")}
          </button>
        </div>

        {mode === "obsidian" ? (
          <form className="onboarding-form" onSubmit={saveObsidianSetup}>
            <label>
              <span>{t("onboarding.storageMode")}</span>
              <select
                autoFocus
                value={obsidianForm.obsidian_storage_backend}
                onChange={(event) => setObsidianForm((current) => ({ ...current, obsidian_storage_backend: event.target.value }))}
              >
                <option value="local">{t("onboarding.storage.local")}</option>
                <option value="oss">{t("onboarding.storage.oss")}</option>
                <option value="s3">{t("onboarding.storage.s3")}</option>
                <option value="r2">Cloudflare R2</option>
              </select>
            </label>
            {["oss", "s3", "r2"].includes(obsidianForm.obsidian_storage_backend) ? (
              <>
                <label>
                  <span>{t("onboarding.remote.endpointUrl")}</span>
                  <input
                    placeholder={obsidianForm.obsidian_storage_backend === "r2" ? "https://<account>.r2.cloudflarestorage.com" : "https://oss-cn-hangzhou.aliyuncs.com"}
                    value={obsidianForm.obsidian_remote_endpoint_url}
                    onChange={(event) => setObsidianForm((current) => ({ ...current, obsidian_remote_endpoint_url: event.target.value }))}
                  />
                </label>
                <label>
                  <span>{t("onboarding.remote.region")}</span>
                  <input
                    placeholder={obsidianForm.obsidian_storage_backend === "r2" ? "auto" : "cn-hangzhou"}
                    value={obsidianForm.obsidian_remote_region}
                    onChange={(event) => setObsidianForm((current) => ({ ...current, obsidian_remote_region: event.target.value }))}
                  />
                </label>
                <label>
                  <span>{t("onboarding.remote.bucket")}</span>
                  <input
                    placeholder="obsidian-vault"
                    value={obsidianForm.obsidian_remote_bucket}
                    onChange={(event) => setObsidianForm((current) => ({ ...current, obsidian_remote_bucket: event.target.value }))}
                  />
                </label>
                <label>
                  <span>{t("onboarding.remote.vaultPrefix")}</span>
                  <input
                    placeholder="vault"
                    value={obsidianForm.obsidian_remote_prefix}
                    onChange={(event) => setObsidianForm((current) => ({ ...current, obsidian_remote_prefix: event.target.value }))}
                  />
                </label>
                <label>
                  <span>{t("onboarding.outputPrefix")}</span>
                  <input
                    placeholder="Research Intelligence"
                    value={obsidianForm.obsidian_remote_output_prefix}
                    onChange={(event) => setObsidianForm((current) => ({ ...current, obsidian_remote_output_prefix: event.target.value }))}
                  />
                </label>
                <label>
                  <span>{t("onboarding.mirrorDirectory")}</span>
                  <input
                    placeholder="./data/obsidian_remote_vault"
                    value={obsidianForm.obsidian_remote_mirror_dir}
                    onChange={(event) => setObsidianForm((current) => ({ ...current, obsidian_remote_mirror_dir: event.target.value }))}
                  />
                </label>
                <label>
                  <span>{t("onboarding.remote.accessKeyId")}</span>
                  <input
                    placeholder={t("onboarding.remote.accessKeyId")}
                    value={obsidianForm.obsidian_remote_access_key_id}
                    onChange={(event) => setObsidianForm((current) => ({ ...current, obsidian_remote_access_key_id: event.target.value }))}
                  />
                </label>
                <label>
                  <span>{t("onboarding.remote.accessSecret")}</span>
                  <input
                    placeholder={t("onboarding.remote.accessSecret")}
                    type="password"
                    value={obsidianForm.obsidian_remote_secret_access_key}
                    onChange={(event) => setObsidianForm((current) => ({ ...current, obsidian_remote_secret_access_key: event.target.value }))}
                  />
                </label>
              </>
            ) : (
              <label>
                <span>{t("onboarding.vault")}</span>
                <div className="path-input-row">
                  <input
                    placeholder="D:\\Obsidian\\Vault"
                    value={obsidianForm.obsidian_vault_path}
                    onChange={(event) => setObsidianForm((current) => ({ ...current, obsidian_vault_path: event.target.value }))}
                  />
                  <button disabled={Boolean(busy)} onClick={pickObsidianVault} type="button">{t("actions.select", { ns: "common" })}</button>
                </div>
              </label>
            )}
            <label>
              <span>{t("onboarding.scanFolders")}</span>
              <input
                placeholder="Research,Papers"
                value={obsidianForm.obsidian_include_dirs}
                onChange={(event) => setObsidianForm((current) => ({ ...current, obsidian_include_dirs: event.target.value }))}
              />
            </label>
            <label>
              <span>{t("onboarding.centerTags")}</span>
              <input
                placeholder="project,center"
                value={obsidianForm.obsidian_project_center_tags}
                onChange={(event) => setObsidianForm((current) => ({ ...current, obsidian_project_center_tags: event.target.value }))}
              />
            </label>
            <div className="onboarding-actions">
              <button className="primary" disabled={Boolean(busy)} type="submit">{t("onboarding.saveObsidian")}</button>
            </div>
          </form>
        ) : (
          <form className="onboarding-form onboarding-project-form" onSubmit={createManualProject}>
            <label>
              <span>{t("onboarding.projectName")}</span>
              <input
                autoFocus
                placeholder="Agentic RAG"
                value={projectForm.name}
                onChange={(event) => setProjectForm((current) => ({ ...current, name: event.target.value }))}
              />
            </label>
            <label>
              <span>{t("onboarding.projectStatus")}</span>
              <select
                value={projectForm.status}
                onChange={(event) => setProjectForm((current) => ({ ...current, status: event.target.value }))}
              >
                {PROJECT_STATUSES.map((value) => <option key={value} value={value}>{t(`projectStatus.${value}`, { ns: "common" })}</option>)}
              </select>
            </label>
            <label>
              <span>{t("onboarding.keywords")}</span>
              <input
                placeholder="RAG,agent,scientific discovery"
                value={projectForm.keywords}
                onChange={(event) => setProjectForm((current) => ({ ...current, keywords: event.target.value }))}
              />
            </label>
            <label className="wide">
              <span>{t("onboarding.rawContext")}</span>
              <textarea
                placeholder={t("onboarding.rawContextPlaceholder")}
                rows={5}
                value={projectForm.raw_context}
                onChange={(event) => setProjectForm((current) => ({ ...current, raw_context: event.target.value }))}
              />
            </label>
            <div className="onboarding-actions">
              <button className="primary" disabled={Boolean(busy)} type="submit">{t("onboarding.createProject")}</button>
            </div>
          </form>
        )}

        {busy ? (
          <div className="onboarding-busy">
            <InlineLoader label={t(`onboarding.busy.${busy === "vault" ? "vault" : busy === "obsidian" ? "obsidian" : "project"}`)} />
          </div>
        ) : null}
      </section>
    </div>
  );
}
