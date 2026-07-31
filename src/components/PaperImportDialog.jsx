import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { cacheNamespace, useApiCacheClient } from "../lib/apiCache.jsx";
import { api, postJson } from "../lib/dashboard.js";
import { InlineLoader } from "./Loading.jsx";
import { WorkspaceDialog } from "./WorkspaceDialog.jsx";
import "../styles/PaperImportDialog.css";

export function PaperImportDialog({ onClose, onImported, open, setStatusMessage }) {
  const { t } = useTranslation("papers");
  const cache = useApiCacheClient();
  const [urls, setUrls] = useState("");
  const [webUrls, setWebUrls] = useState("");
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const pdfUrlInputRef = useRef(null);

  function invalidatePaperCaches() {
    cache.markStale(cacheNamespace("library"));
    cache.markStale(cacheNamespace("reader", "papers"));
    cache.markStale(cacheNamespace("reader", "conversations"));
    cache.markStale(cacheNamespace("paper-reports"));
  }

  function handleQueued(message) {
    cache.markStale(["jobs", "summary"]);
    cache.markStale(["jobs", "history"]);
    invalidatePaperCaches();
    onClose?.();
    setStatusMessage(message);
  }

  async function completeImport(data, message, firstPaperId) {
    invalidatePaperCaches();
    onClose?.();
    setStatusMessage(message);
    await onImported?.(firstPaperId || null);
  }

  async function submitUrls(event) {
    event.preventDefault();
    if (!urls.trim()) return;
    setBusy(true);
    try {
      const data = await postJson("/api/reader/papers/urls", { urls });
      setUrls("");
      if (data?.queued) {
        handleQueued(t("reader.messages.urlQueued"));
        return;
      }
      await completeImport(
        data,
        t("reader.messages.urlComplete", { imported: data.imported?.length || 0, failed: data.errors?.length || 0 }),
        data.imported?.[0]?.paper_id
      );
    } catch (error) {
      setStatusMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function submitWebpages(event) {
    event.preventDefault();
    if (!webUrls.trim()) return;
    setBusy(true);
    try {
      const data = await postJson("/api/reader/papers/web", { urls: webUrls });
      setWebUrls("");
      if (data?.queued) {
        handleQueued(t("reader.messages.webQueued"));
        return;
      }
      await completeImport(
        data,
        t("reader.messages.webComplete", { imported: data.imported?.length || 0, failed: data.errors?.length || 0 }),
        data.imported?.[0]?.paper_id
      );
    } catch (error) {
      setStatusMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function submitPdf(event) {
    event.preventDefault();
    if (!selectedFiles.length) return;
    setBusy(true);
    try {
      const formData = new FormData();
      for (const file of selectedFiles) formData.append("files", file, file.name);
      const data = await api("/api/reader/papers/upload", { method: "POST", body: formData });
      setSelectedFiles([]);
      event.currentTarget.reset();
      if (data?.queued) {
        handleQueued(t("reader.messages.pdfQueued"));
        return;
      }
      await completeImport(
        data,
        t("reader.messages.pdfComplete", { imported: data.imported?.length || 0, failed: data.errors?.length || 0 }),
        data.imported?.[0]?.paper_id || data.last_detail?.paper?.id
      );
    } catch (error) {
      setStatusMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <WorkspaceDialog
      className="reader-import-dialog"
      eyebrow={t("reader.importEyebrow")}
      footer={<div><button disabled={busy} onClick={onClose} type="button">{t("common.close")}</button></div>}
      icon="IN"
      initialFocusRef={pdfUrlInputRef}
      onClose={() => { if (!busy) onClose?.(); }}
      open={open}
      title={t("reader.import.title")}
    >
      <div className="reader-import-dialog-body">
        <form className="reader-import-method" onSubmit={submitUrls}>
          <header><i aria-hidden="true">URL</i><div><span>{t("reader.import.pdfLinks")}</span><h3>{t("reader.import.fromLinks")}</h3></div></header>
          <label className="workspace-field">
            <span>{t("reader.importUrlLabel")}</span>
            <textarea disabled={busy} onChange={(event) => setUrls(event.target.value)} placeholder={"https://arxiv.org/abs/2401.00001\nhttps://arxiv.org/abs/2401.00002"} ref={pdfUrlInputRef} value={urls} />
          </label>
          <button className="reader-import-submit" disabled={busy || !urls.trim()} type="submit">
            {busy ? <InlineLoader compact label={t("reader.import.importing")} /> : <>{t("reader.import.findPdf")} <i aria-hidden="true">→</i></>}
          </button>
        </form>
        <form className="reader-import-method" onSubmit={submitPdf}>
          <header><i aria-hidden="true">PDF</i><div><span>{t("reader.import.localFiles")}</span><h3>{t("reader.import.uploadPdf")}</h3></div></header>
          <label className="reader-import-file-picker">
            <input accept="application/pdf,.pdf" disabled={busy} multiple onChange={(event) => setSelectedFiles([...(event.target.files || [])])} type="file" />
            <i aria-hidden="true">＋</i>
            <span>
              <strong>{selectedFiles.length ? t("reader.import.selectedPdf", { count: selectedFiles.length }) : t("reader.import.selectPdf")}</strong>
              <small>{selectedFiles.length ? selectedFiles.map((file) => file.name).join(t("common.listSeparator")) : t("reader.import.pdfHint")}</small>
            </span>
          </label>
          <button className="reader-import-submit" disabled={busy || !selectedFiles.length} type="submit">
            {busy ? <InlineLoader compact label={t("reader.import.importing")} /> : <>{t("reader.import.importPdf", { count: selectedFiles.length || "" })} <i aria-hidden="true">→</i></>}
          </button>
        </form>
        <form className="reader-import-method is-webpage" onSubmit={submitWebpages}>
          <header><i aria-hidden="true">WEB</i><div><span>{t("reader.import.webText")}</span><h3>{t("reader.import.extractWeb")}</h3></div></header>
          <label className="workspace-field">
            <span>{t("reader.import.webUrls")}</span>
            <textarea disabled={busy} onChange={(event) => setWebUrls(event.target.value)} placeholder={"https://example.com/article\nhttps://example.org/blog/post"} value={webUrls} />
          </label>
          <button className="reader-import-submit" disabled={busy || !webUrls.trim()} type="submit">
            {busy ? <InlineLoader compact label={t("reader.import.extracting")} /> : <>{t("reader.import.extractAction")} <i aria-hidden="true">→</i></>}
          </button>
        </form>
      </div>
    </WorkspaceDialog>
  );
}
