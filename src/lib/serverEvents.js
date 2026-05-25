import { useEffect } from "react";

import { cacheNamespace, useApiCacheClient } from "./apiCache.jsx";

export const SERVER_EVENTS = Object.freeze({
  ARTIFACT_CREATED: "artifact.created",
  ARTIFACT_UPDATED: "artifact.updated",
  EVENTS_CONNECTED: "events.connected",
  EXPERIMENT_REPORT_UPSERTED: "experiment_report.upserted",
  JOB_FAILED: "job.failed",
  JOB_FINISHED: "job.finished",
  JOB_STARTED: "job.started",
  PAPER_FEEDBACK_UPDATED: "paper.feedback.updated",
  PAPER_LIBRARY_STATUS_UPDATED: "paper.library_status.updated",
  PAPER_RECOMMENDATION_UPDATED: "paper.recommendation.updated",
  PAPER_REPORT_DELETED: "paper_report.deleted",
  PAPER_REPORT_UPDATED: "paper_report.updated",
  PROJECT_CREATED: "project.created",
  PROJECT_NOTE_LINKED: "project_note.linked",
  PROJECT_NOTE_UNLINKED: "project_note.unlinked",
  PROJECT_PAPER_LINKED: "project_paper.linked",
  PROJECT_PAPER_UNLINKED: "project_paper.unlinked",
  PROJECT_UPDATED: "project.updated",
  READER_MESSAGE_DELETED: "reader.message.deleted",
  READER_MESSAGE_UPDATED: "reader.message.updated",
  READER_PAPER_UPDATED: "reader.paper.updated",
  READER_PAPERS_IMPORTED: "reader.papers.imported",
  SETTINGS_CHANGED: "settings.changed",
  TASK_FAILED: "task.failed",
  TASK_FINISHED: "task.finished",
  TASK_STARTED: "task.started"
});

const PROJECT_EVENTS = new Set([SERVER_EVENTS.PROJECT_CREATED, SERVER_EVENTS.PROJECT_UPDATED]);
const PROJECT_PAPER_EVENTS = new Set([SERVER_EVENTS.PROJECT_PAPER_LINKED, SERVER_EVENTS.PROJECT_PAPER_UNLINKED]);
const PROJECT_NOTE_EVENTS = new Set([SERVER_EVENTS.PROJECT_NOTE_LINKED, SERVER_EVENTS.PROJECT_NOTE_UNLINKED]);
const PAPER_EVENTS = new Set([
  SERVER_EVENTS.PAPER_FEEDBACK_UPDATED,
  SERVER_EVENTS.PAPER_LIBRARY_STATUS_UPDATED,
  SERVER_EVENTS.PAPER_RECOMMENDATION_UPDATED
]);
const PAPER_REPORT_EVENTS = new Set([SERVER_EVENTS.PAPER_REPORT_UPDATED, SERVER_EVENTS.PAPER_REPORT_DELETED]);
const READER_PAPER_EVENTS = new Set([
  SERVER_EVENTS.READER_MESSAGE_DELETED,
  SERVER_EVENTS.READER_MESSAGE_UPDATED,
  SERVER_EVENTS.READER_PAPER_UPDATED
]);
const TASK_EVENTS = new Set([
  SERVER_EVENTS.JOB_FAILED,
  SERVER_EVENTS.JOB_FINISHED,
  SERVER_EVENTS.JOB_STARTED,
  SERVER_EVENTS.TASK_FAILED,
  SERVER_EVENTS.TASK_FINISHED,
  SERVER_EVENTS.TASK_STARTED
]);

function asStringId(value) {
  return value === null || value === undefined ? "" : String(value);
}

function markProjectChanged(cache, projectId) {
  cache.markStale(["projects"]);
  if (projectId) cache.markStale(["project", asStringId(projectId)]);
  cache.markStale(["health"]);
  cache.markStale(["health", "summary"]);
  cache.markStale(["reminders"]);
}

function markArtifactChanged(cache, artifactId) {
  cache.markStale(["artifacts"]);
  if (artifactId) cache.markStale(["artifact", asStringId(artifactId)]);
  cache.markStale(["paper-reports", "summary"]);
  cache.markStale(["health"]);
  cache.markStale(["health", "summary"]);
}

function markPaperChanged(cache, paperId) {
  cache.markStale(["inbox"]);
  cache.markStale(["library"]);
  cache.markStale(["reader", "papers"]);
  cache.markStale(["paper-reports"]);
  cache.markStale(["paper-reports", "summary"]);
  if (paperId) {
    const id = asStringId(paperId);
    cache.markStale(["paper", "detail", id]);
    cache.markStale(["library", "detail", id]);
    cache.markStale(["reader", "paper", id]);
  }
  cache.markStale(["health"]);
  cache.markStale(["health", "summary"]);
  cache.markStale(["reminders"]);
}

function markReaderPapersChanged(cache, imported = []) {
  cache.markStale(["reader", "papers"]);
  cache.markStale(["library"]);
  cache.markStale(["health"]);
  cache.markStale(["health", "summary"]);
  for (const item of imported) {
    const paperId = item?.paper_id || item?.id;
    if (paperId) markPaperChanged(cache, paperId);
  }
}

function markGlobalStale(cache) {
  cache.markStale(["settings"]);
  cache.markStale(["health"]);
  cache.markStale(["health", "summary"]);
  cache.markStale(["jobs", "status"]);
  cache.markStale(["jobs", "summary"]);
  cache.markStale(["jobs", "history"]);
  cache.markStale(["paper-reports"]);
  cache.markStale(["paper-reports", "summary"]);
  cache.markStale(["inbox"]);
  cache.markStale(["library"]);
  cache.markStale(cacheNamespace("library", "detail"));
  cache.markStale(["reader", "papers"]);
  cache.markStale(cacheNamespace("reader", "paper"));
  cache.markStale(["projects"]);
  cache.markStale(cacheNamespace("project"));
  cache.markStale(["artifacts"]);
  cache.markStale(cacheNamespace("artifact"));
  cache.markStale(["reminders"]);
}

function applyServerEvent(cache, event) {
  const type = String(event?.type || "");
  const data = event?.data && typeof event.data === "object" ? event.data : event;
  const artifact = data?.artifact && typeof data.artifact === "object" ? data.artifact : {};
  const paper = data?.paper && typeof data.paper === "object" ? data.paper : {};
  const projectId = data?.project_id || data?.projectId || artifact.scope_id;
  const artifactId = data?.artifact_id || data?.artifactId || artifact.id;
  const paperId = data?.paper_id || data?.paperId || paper.paper_id || paper.id;
  const scheduler = data?.scheduler || event?.scheduler;

  if (type === "connected" || type === "ping" || type === SERVER_EVENTS.EVENTS_CONNECTED) return;

  if (type === SERVER_EVENTS.EXPERIMENT_REPORT_UPSERTED) {
    markProjectChanged(cache, projectId);
    markArtifactChanged(cache, artifactId);
    return;
  }

  if (type === SERVER_EVENTS.ARTIFACT_CREATED || type === SERVER_EVENTS.ARTIFACT_UPDATED) {
    markArtifactChanged(cache, artifactId);
    if (projectId) markProjectChanged(cache, projectId);
    return;
  }

  if (PROJECT_EVENTS.has(type)) {
    markProjectChanged(cache, projectId);
    return;
  }

  if (PROJECT_PAPER_EVENTS.has(type)) {
    markProjectChanged(cache, projectId);
    markPaperChanged(cache, paperId);
    return;
  }

  if (PROJECT_NOTE_EVENTS.has(type)) {
    markProjectChanged(cache, projectId);
    return;
  }

  if (PAPER_REPORT_EVENTS.has(type)) {
    markPaperChanged(cache, paperId);
    if (type === SERVER_EVENTS.PAPER_REPORT_DELETED || artifactId) {
      markArtifactChanged(cache, artifactId);
    }
    return;
  }

  if (PAPER_EVENTS.has(type)) {
    markPaperChanged(cache, paperId);
    const projectIds = Array.isArray(data?.project_ids) ? data.project_ids : [];
    for (const id of projectIds) markProjectChanged(cache, id);
    return;
  }

  if (type === SERVER_EVENTS.READER_PAPERS_IMPORTED) {
    markReaderPapersChanged(cache, Array.isArray(data.imported) ? data.imported : []);
    return;
  }

  if (READER_PAPER_EVENTS.has(type)) {
    markPaperChanged(cache, paperId);
    return;
  }

  if (type === SERVER_EVENTS.SETTINGS_CHANGED) {
    cache.markStale(["settings"]);
    cache.markStale(["health"]);
    cache.markStale(["health", "summary"]);
    if (scheduler) cache.setCache(["jobs", "status"], { scheduler });
    else cache.markStale(["jobs", "status"]);
    return;
  }

  if (TASK_EVENTS.has(type)) {
    if (scheduler) cache.setCache(["jobs", "status"], { scheduler });
    else cache.markStale(["jobs", "status"]);
    cache.markStale(["jobs", "summary"]);
    cache.markStale(["jobs", "history"]);
    cache.markStale(["paper-reports", "summary"]);
    cache.markStale(["paper-reports"]);
    cache.markStale(["reader", "papers"]);
    cache.markStale(cacheNamespace("reader", "paper"));
    cache.markStale(["health"]);
    cache.markStale(["health", "summary"]);
  }
}

export function useServerEvents({ enabled = true, notify = () => {} } = {}) {
  const cache = useApiCacheClient();

  useEffect(() => {
    if (!enabled || typeof window === "undefined" || typeof window.EventSource !== "function") return undefined;

    const source = new window.EventSource("/api/events");
    let opened = false;
    let needsResync = false;
    const handleOpen = () => {
      if (opened || needsResync) markGlobalStale(cache);
      opened = true;
      needsResync = false;
    };
    const handleMessage = (message) => {
      let event = null;
      try {
        event = JSON.parse(message.data || "{}");
      } catch {
        return;
      }
      applyServerEvent(cache, event);
      if (event?.type === SERVER_EVENTS.EXPERIMENT_REPORT_UPSERTED) {
        notify("收到新的实验报告", { type: "info" });
      }
    };
    const eventTypes = Object.values(SERVER_EVENTS);

    for (const eventType of eventTypes) {
      source.addEventListener(eventType, handleMessage);
    }
    source.addEventListener("open", handleOpen);
    source.onmessage = handleMessage;
    source.onerror = () => {
      needsResync = true;
      markGlobalStale(cache);
    };

    return () => {
      for (const eventType of eventTypes) {
        source.removeEventListener(eventType, handleMessage);
      }
      source.removeEventListener("open", handleOpen);
      source.close();
    };
  }, [cache, enabled, notify]);
}
