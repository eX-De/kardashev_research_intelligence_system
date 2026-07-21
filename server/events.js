export const SERVER_EVENTS = Object.freeze({
  ARTIFACT_CREATED: "artifact.created",
  ARTIFACT_UPDATED: "artifact.updated",
  APP_UPDATE_AVAILABLE: "app.update_available",
  DAILY_RUN_PROGRESS_UPDATED: "daily_run_progress.updated",
  EVENTS_CONNECTED: "events.connected",
  EXPERIMENT_REPORT_UPSERTED: "experiment_report.upserted",
  JOB_FAILED: "job.failed",
  JOB_FINISHED: "job.finished",
  JOB_STARTED: "job.started",
  PAPERS_CHANGED: "papers.changed",
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
  SEARCH_COMPLETED: "search.completed",
  TASK_FAILED: "task.failed",
  TASK_FINISHED: "task.finished",
  TASK_STARTED: "task.started"
});

function normalizeEventType(type) {
  const normalized = String(type || "message").replace(/[^\w.-]/g, "_");
  return normalized || "message";
}

function compactTaskResult(result) {
  if (!result || typeof result !== "object") return result ?? null;
  const summary = {};
  for (const key of ["ok", "message", "stats", "created", "updated", "skipped", "errors"]) {
    if (Object.hasOwn(result, key)) summary[key] = result[key];
  }
  return Object.keys(summary).length ? summary : null;
}

function compactRuntimeJob(job) {
  if (!job) return null;
  return {
    id: job.id || null,
    command: job.command || null,
    source: job.source || null,
    args: Array.isArray(job.args) ? job.args : [],
    status: job.status || null,
    started_at: job.started_at || null,
    finished_at: job.finished_at || null,
    message: job.message || null
  };
}

export function compactSchedulerPayload(status = {}) {
  return {
    ...status,
    current_job: compactRuntimeJob(status.current_job),
    last_job: compactRuntimeJob(status.last_job),
    paper_report_queue: {
      ...status.paper_report_queue,
      active_jobs: (status.paper_report_queue?.active_jobs || []).map(compactRuntimeJob)
    }
  };
}

export function compactTaskEventPayload(job, options = {}, scheduler = null) {
  const jobPayload = job?.payload && typeof job.payload === "object" ? job.payload : {};
  const task = {
    id: job?.job_run_id || job?.job_id || job?.id || null,
    worker_job_id: job?.worker_job_id || (job?.job_run_id ? job?.id : null),
    command: jobPayload.command || job?.command || job?.job_type || null,
    source: jobPayload.source || job?.source || null,
    args: Array.isArray(jobPayload.args) ? jobPayload.args : Array.isArray(job?.args) ? job.args : [],
    status: options.status || job?.status || "running",
    started_at: job?.started_at || null,
    finished_at: job?.finished_at || null,
    message: options.message || job?.message || job?.error_message || null
  };
  if (options.result !== undefined) {
    task.result = compactTaskResult(options.result);
  }
  const payload = { task };
  if (scheduler) payload.scheduler = compactSchedulerPayload(scheduler);
  if (options.stale) payload.stale = true;
  return payload;
}

export function eventNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

function compactDailyProgressEvent(payload, command) {
  if (payload?.event && payload.event !== SERVER_EVENTS.DAILY_RUN_PROGRESS_UPDATED) return null;
  const data = payload?.data && typeof payload.data === "object" ? payload.data : payload;
  if (!data || typeof data !== "object") return null;
  if (!data.job_id && !data.current_key && !data.current_label) return null;
  return {
    job_id: data.job_id || null,
    job_type: data.job_type || command || null,
    status: data.status || null,
    current: data.current || null,
    total: data.total || null,
    completed: data.completed || 0,
    current_key: data.current_key || null,
    current_label: data.current_label || null,
    updated_at: data.updated_at || new Date().toISOString()
  };
}

export function compactUpdatePayload(data = {}) {
  const update = data.notification?.source?.update || {};
  return {
    ok: Boolean(data.ok),
    available: Boolean(data.available),
    checked_at: data.checked_at || update.checked_at || null,
    current_version: data.current_version || update.current_version || null,
    latest_version: data.latest_version || update.latest_version || null,
    latest_tag: data.latest_tag || update.latest_tag || null,
    repository: data.repository || update.repository || null,
    release_url: data.release_url || update.release_url || null,
    source: data.source || update.source || null
  };
}

export function compactExperimentReportPayload(data) {
  const artifact = data?.artifact && typeof data.artifact === "object" ? data.artifact : {};
  const contentJson = artifact.content_json && typeof artifact.content_json === "object"
    ? artifact.content_json
    : {};
  const knowledgeDocument = data?.knowledge_document && typeof data.knowledge_document === "object"
    ? data.knowledge_document
    : contentJson.knowledge_document;

  const projectId = contentJson.project_id ?? artifact.scope_id ?? null;
  const sourceAgent = contentJson.source_agent ?? null;
  const artifactId = artifact.id ?? null;
  const updatedAt = artifact.updated_at ?? contentJson.received_at ?? null;
  const detail = [
    artifact.title || "未命名实验报告",
    projectId ? `项目 ${projectId}` : "",
    sourceAgent ? `来源 ${sourceAgent}` : "",
    updatedAt ? `更新于 ${updatedAt}` : ""
  ].filter(Boolean).join(" · ");

  return {
    artifact: {
      id: artifactId,
      artifact_type: artifact.artifact_type ?? null,
      title: artifact.title ?? null,
      scope_type: artifact.scope_type ?? null,
      scope_id: artifact.scope_id ?? null,
      created_at: artifact.created_at ?? null,
      updated_at: updatedAt
    },
    project_id: projectId,
    source_agent: sourceAgent,
    idempotency_key: contentJson.idempotency_key ?? null,
    received_at: contentJson.received_at ?? null,
    knowledge_document: knowledgeDocument ? {
      document_id: knowledgeDocument.document_id ?? null,
      chunks_created: knowledgeDocument.chunks_created ?? null,
      embeddings_created: knowledgeDocument.embeddings_created ?? null,
      relation: knowledgeDocument.relation ?? null,
      source_type: knowledgeDocument.source_type ?? null
    } : null,
    obsidian: data?.obsidian ?? contentJson.obsidian_export ?? null,
    notification: {
      id: artifactId ? `experiment-report-upserted-${artifactId}` : "experiment-report-upserted",
      type: "experiment_report_arrived",
      severity: "info",
      title: "收到实验报告",
      detail,
      created_at: updatedAt,
      source: {
        artifact_id: artifactId,
        project_id: projectId,
        source_agent: sourceAgent
      },
      channels: ["toast"],
      requires_action: false
    }
  };
}

export function compactProjectPayload(data = {}, fallbackId = null) {
  const project = data?.project && typeof data.project === "object" ? data.project : {};
  const projectId = eventNumber(project.id ?? data.project_id ?? fallbackId);
  return {
    project_id: projectId,
    id: projectId,
    name: project.name || null,
    status: project.status || null,
    updated_at: project.updated_at || data.updated_at || null
  };
}

export function compactSettingsChangedPayload(scheduler = {}) {
  return {
    scheduler: compactSchedulerPayload(scheduler)
  };
}

export function compactProjectChangedPayload(data = {}, fallbackId = null, extra = {}) {
  return {
    project: compactProjectPayload(data, fallbackId),
    project_id: eventNumber(data?.project?.id ?? data?.project_id ?? fallbackId),
    ...extra
  };
}

export function compactArtifactPayload(data = {}, fallbackId = null) {
  const artifact = data?.artifact && typeof data.artifact === "object"
    ? data.artifact
    : data?.generated_artifact && typeof data.generated_artifact === "object"
      ? data.generated_artifact
      : {};
  const artifactId = eventNumber(artifact.id ?? data.artifact_id ?? fallbackId);
  return {
    artifact_id: artifactId,
    id: artifactId,
    artifact_type: artifact.artifact_type || null,
    title: artifact.title || null,
    scope_type: artifact.scope_type || null,
    scope_id: eventNumber(artifact.scope_id),
    status: artifact.status || null,
    updated_at: artifact.updated_at || data.updated_at || null
  };
}

export function compactArtifactChangedPayload(data = {}, fallbackId = null, extra = {}) {
  const artifact = compactArtifactPayload(data, fallbackId);
  return {
    artifact,
    artifact_id: artifact.artifact_id,
    project_id: artifact.scope_type === "project" ? artifact.scope_id : eventNumber(data?.project_id),
    ...extra
  };
}

export function compactPaperPayload(data = {}, fallbackId = null) {
  const paper = data?.paper && typeof data.paper === "object" ? data.paper : {};
  const report = data?.paper_report && typeof data.paper_report === "object" ? data.paper_report : {};
  const paperId = eventNumber(
    paper.id ??
    report.paper_id ??
    data?.library?.paper_id ??
    data.paper_id ??
    fallbackId
  );
  return {
    paper_id: paperId,
    id: paperId,
    arxiv_id: paper.arxiv_id || data.arxiv_id || null,
    library_status: paper.library_status || data.library_status || null,
    report_status: report.status || data.report_status || null,
    status: data.status || paper.status || null,
    updated_at: paper.updated_at || report.updated_at || data.updated_at || null
  };
}

export function compactPaperChangedPayload(data = {}, fallbackId = null, extra = {}) {
  const paper = compactPaperPayload(data, fallbackId);
  return {
    paper,
    paper_id: paper.paper_id,
    project_ids: projectIdsFromData(data),
    ...extra
  };
}

export function compactPaperReportChangedPayload(data = {}, fallbackId = null, extra = {}) {
  const paper = compactPaperPayload(data, fallbackId);
  const report = data?.paper_report && typeof data.paper_report === "object" ? data.paper_report : {};
  return {
    paper,
    paper_id: paper.paper_id,
    artifact_id: eventNumber(report.artifact_id ?? report.id ?? data.artifact_id),
    status: report.status || data.status || null,
    project_ids: projectIdsFromData(data),
    ...extra
  };
}

export function projectIdsFromData(data = {}) {
  const ids = new Set();
  const candidates = [
    data.project_id,
    data.projectId,
    data.project?.id,
    ...(Array.isArray(data.project_ids) ? data.project_ids : []),
    ...(Array.isArray(data.source_project_ids) ? data.source_project_ids : []),
    ...(Array.isArray(data.project_recommendations) ? data.project_recommendations.map((item) => item.project_id) : []),
    ...(Array.isArray(data.linked_projects) ? data.linked_projects.map((item) => item.project_id) : [])
  ];
  for (const value of candidates) {
    const id = eventNumber(value);
    if (id) ids.add(id);
  }
  return Array.from(ids);
}

export function createEventPublisher({
  heartbeatMs,
  dailyProgressThrottleMs,
  getSchedulerStatus = () => ({})
}) {
  const eventBus = {
    nextEventId: 1,
    nextClientId: 1,
    clients: new Map(),
    heartbeatTimer: null
  };

  function removeEventClient(clientId) {
    eventBus.clients.delete(clientId);
    if (eventBus.clients.size === 0 && eventBus.heartbeatTimer) {
      clearInterval(eventBus.heartbeatTimer);
      eventBus.heartbeatTimer = null;
    }
  }

  function writeSseMessage(client, message) {
    if (!client || client.res.writableEnded || client.res.destroyed) {
      removeEventClient(client?.id);
      return false;
    }
    try {
      client.res.write(message);
      return true;
    } catch {
      removeEventClient(client.id);
      return false;
    }
  }

  function writeSseEvent(client, event) {
    return writeSseMessage(
      client,
      `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
    );
  }

  function ensureEventHeartbeat() {
    if (eventBus.heartbeatTimer || eventBus.clients.size === 0) return;
    eventBus.heartbeatTimer = setInterval(() => {
      for (const client of eventBus.clients.values()) {
        writeSseMessage(client, `: ping ${new Date().toISOString()}\n\n`);
      }
    }, heartbeatMs);
    eventBus.heartbeatTimer.unref?.();
  }

  function publishEvent(type, data = {}) {
    const event = {
      id: eventBus.nextEventId++,
      type: normalizeEventType(type),
      emitted_at: new Date().toISOString(),
      data
    };
    for (const client of eventBus.clients.values()) {
      writeSseEvent(client, event);
    }
    return event;
  }

  function openEventStream(req, res) {
    const clientId = `${Date.now()}-${eventBus.nextClientId++}`;
    const client = { id: clientId, res };
    eventBus.clients.set(clientId, client);

    req.socket?.setTimeout?.(0);
    req.socket?.setKeepAlive?.(true);
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "connection": "keep-alive",
      "x-accel-buffering": "no"
    });
    res.flushHeaders?.();

    req.on("close", () => {
      removeEventClient(clientId);
    });

    writeSseEvent(client, {
      id: eventBus.nextEventId++,
      type: SERVER_EVENTS.EVENTS_CONNECTED,
      emitted_at: new Date().toISOString(),
      data: { client_id: clientId }
    });
    ensureEventHeartbeat();
  }

  function compactSchedulerStatus(status = getSchedulerStatus()) {
    return compactSchedulerPayload(status);
  }

  function publishTaskEvent(type, job, options = {}) {
    return publishEvent(type, compactTaskEventPayload(job, options, getSchedulerStatus()));
  }

  function createDailyProgressPublisher(command) {
    let latestProgress = null;
    let timer = null;
    let lastPublishedAt = 0;

    function emit() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (!latestProgress) return;
      const progress = latestProgress;
      latestProgress = null;
      lastPublishedAt = Date.now();
      publishEvent(SERVER_EVENTS.DAILY_RUN_PROGRESS_UPDATED, {
        progress,
        scheduler: compactSchedulerStatus()
      });
    }

    function queue(payload) {
      const progress = compactDailyProgressEvent(payload, command);
      if (!progress) return;
      latestProgress = progress;
      const elapsed = Date.now() - lastPublishedAt;
      if (elapsed >= dailyProgressThrottleMs) {
        emit();
        return;
      }
      if (!timer) {
        timer = setTimeout(emit, dailyProgressThrottleMs - elapsed);
        timer.unref?.();
      }
    }

    function stop() {
      if (timer) clearTimeout(timer);
      timer = null;
      latestProgress = null;
    }

    return { flush: emit, queue, stop };
  }

  function publishSettingsChanged(_settings, scheduler = getSchedulerStatus()) {
    return publishEvent(SERVER_EVENTS.SETTINGS_CHANGED, compactSettingsChangedPayload(scheduler));
  }

  function publishProjectChanged(type, data = {}, fallbackId = null, extra = {}) {
    return publishEvent(type, compactProjectChangedPayload(data, fallbackId, extra));
  }

  function publishArtifactChanged(type, data = {}, fallbackId = null, extra = {}) {
    return publishEvent(type, compactArtifactChangedPayload(data, fallbackId, extra));
  }

  function publishPaperChanged(type, data = {}, fallbackId = null, extra = {}) {
    return publishEvent(type, compactPaperChangedPayload(data, fallbackId, extra));
  }

  function publishPaperReportChanged(type, data = {}, fallbackId = null, extra = {}) {
    return publishEvent(type, compactPaperReportChangedPayload(data, fallbackId, extra));
  }

  return {
    compactSchedulerStatus,
    createDailyProgressPublisher,
    openEventStream,
    publishArtifactChanged,
    publishEvent,
    publishPaperChanged,
    publishPaperReportChanged,
    publishProjectChanged,
    publishSettingsChanged,
    publishTaskEvent
  };
}
