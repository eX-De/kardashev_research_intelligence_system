function text(value) {
  return String(value ?? "").trim();
}

function value(object, key, fallback = "") {
  return object && Object.prototype.hasOwnProperty.call(object, key) ? object[key] : fallback;
}

function notificationData(notification) {
  return notification?.data && typeof notification.data === "object"
    ? notification.data
    : {};
}

function translatedJobType(jobType, t) {
  const type = text(jobType);
  if (!type) return t("common:jobType.unknown");
  return t(`common:jobType.${type}`, { defaultValue: type });
}

export function dailyStepLabel(stepKey, fallback, t) {
  const key = text(stepKey);
  if (!key) return text(fallback) || t("system:dailySteps.preparing");
  return t(`system:dailySteps.${key}`, { defaultValue: text(fallback) || key });
}

function dailyCompletedDetail(data, fallback, t) {
  const parts = [];
  const counts = [
    ["new_papers", "newPapers"],
    ["project_matches", "projectMatches"],
    ["paper_reports", "paperReports"],
    ["archived", "archived"],
    ["filtered", "filtered"]
  ];
  for (const [field, key] of counts) {
    const count = Number(value(data, field, 0));
    if (count > 0) parts.push(t(`notifications.daily_run_completed.parts.${key}`, { count }));
  }
  const reportPath = text(data.daily_report_path);
  if (reportPath) parts.push(t("notifications.daily_run_completed.parts.dailyReport", { path: reportPath }));
  return parts.length
    ? parts.join(t("common:listSeparator"))
    : text(fallback) || t("notifications.daily_run_completed.fallback");
}

export function formatNotification(notification, t) {
  if (!notification || typeof notification !== "object") {
    return {
      detail: "",
      title: t("notifications.unknown.title")
    };
  }

  const data = notificationData(notification);
  const fallbackTitle = text(notification.title);
  const fallbackDetail = text(notification.detail);
  const fallback = {
    detail: fallbackDetail,
    title: fallbackTitle || t("notifications.unknown.title")
  };

  switch (text(notification.type)) {
    case "empty":
      return {
        title: t("notifications.empty.title"),
        detail: t("notifications.empty.detail")
      };
    case "daily_run_progress": {
      const progress = notification.progress || {};
      return {
        title: t("notifications.daily_run_progress.title"),
        detail: dailyStepLabel(
          data.current_key || progress.current_key,
          data.current_label || progress.current_label || fallbackDetail,
          t
        )
      };
    }
    case "daily_run_recoverable": {
      const recovery = notification.source?.recovery || {};
      const failedStep = dailyStepLabel(
        data.failed_step || recovery.failed_step,
        data.failed_label || recovery.failed_label,
        t
      );
      return {
        title: t("notifications.daily_run_recoverable.title"),
        detail: t("notifications.daily_run_recoverable.detail", {
          completed: Number(data.completed ?? recovery.completed ?? 0),
          failedStep,
          total: Number(data.total ?? recovery.total ?? 0)
        })
      };
    }
    case "arxiv_rate_limited": {
      const failedStep = dailyStepLabel(
        data.failed_step,
        data.failed_label || notification.source?.failed_step,
        t
      );
      const retryAfter = Number(data.retry_after_seconds || notification.source?.retry_after_seconds || 0);
      return {
        title: t("notifications.arxiv_rate_limited.title"),
        detail: retryAfter > 0
          ? t("notifications.arxiv_rate_limited.detailWithRetry", { failedStep, retryAfter })
          : t("notifications.arxiv_rate_limited.detail", { failedStep })
      };
    }
    case "job_running":
      return {
        title: t("notifications.job_running.title"),
        detail: translatedJobType(data.job_type || notification.source?.job_type, t)
      };
    case "job_failed": {
      const job = translatedJobType(data.job_type || notification.source?.job_type, t);
      const message = text(data.message) || fallbackDetail;
      return {
        title: t("notifications.job_failed.title"),
        detail: message
          ? t("notifications.job_failed.detail", { job, message })
          : t("notifications.job_failed.noMessage", { job })
      };
    }
    case "daily_run_completed":
      return {
        title: t("notifications.daily_run_completed.title"),
        detail: dailyCompletedDetail(data, fallbackDetail, t)
      };
    case "arxiv_papers_arrived":
      return {
        title: t("notifications.arxiv_papers_arrived.title"),
        detail: t("notifications.arxiv_papers_arrived.detail", { count: Number(data.count || 0) })
      };
    case "obsidian_sync_completed":
      return {
        title: t("notifications.obsidian_sync_completed.title"),
        detail: Number(data.indexed || 0) > 0
          ? t("notifications.obsidian_sync_completed.detail", {
            chunks: Number(data.chunks || 0),
            count: Number(data.indexed || 0)
          })
          : t("notifications.obsidian_sync_completed.fallback")
      };
    case "paper_text_cached": {
      const parts = [];
      if (Number(data.pdf_count || 0) > 0) {
        parts.push(t("notifications.paper_text_cached.pdf", { count: Number(data.pdf_count) }));
      }
      if (Number(data.text_count || 0) > 0) {
        parts.push(t("notifications.paper_text_cached.text", { count: Number(data.text_count) }));
      }
      if (Number(data.failed_count || 0) > 0) {
        parts.push(t("notifications.paper_text_cached.failed", { count: Number(data.failed_count) }));
      }
      return {
        title: t("notifications.paper_text_cached.title"),
        detail: parts.length ? parts.join(t("common:listSeparator")) : fallbackDetail
      };
    }
    case "paper_matching_completed":
      return {
        title: t("notifications.paper_matching_completed.title"),
        detail: t("notifications.paper_matching_completed.detail", { count: Number(data.count || 0) })
      };
    case "paper_report_queue_processing":
      return {
        title: t("notifications.paper_report_queue_processing.title"),
        detail: t("notifications.paper_report_queue_processing.detail", {
          processing: Number(data.processing || 0),
          queued: Number(data.queued || 0)
        })
      };
    case "paper_report_queue_failed":
      return {
        title: t("notifications.paper_report_queue_failed.title"),
        detail: t("notifications.paper_report_queue_failed.detail", { count: Number(data.failed || 0) })
      };
    case "paper_report_queue_backlog":
      return {
        title: t("notifications.paper_report_queue_backlog.title"),
        detail: t("notifications.paper_report_queue_backlog.detail", { count: Number(data.queued || 0) })
      };
    case "paper_report_completed":
      return {
        title: t("notifications.paper_report_completed.title"),
        detail: t("notifications.paper_report_completed.detail", { count: Number(data.count || 0) })
      };
    case "experiment_report_arrived": {
      const parts = [text(data.title)].filter(Boolean);
      if (data.project_id) parts.push(t("notifications.experiment_report_arrived.project", { id: data.project_id }));
      if (text(data.source_agent)) {
        parts.push(t("notifications.experiment_report_arrived.source", { source: data.source_agent }));
      }
      if (text(data.updated_at)) {
        parts.push(t("notifications.experiment_report_arrived.updated", { value: data.updated_at }));
      }
      return {
        title: t("notifications.experiment_report_arrived.title"),
        detail: parts.length ? parts.join(" · ") : fallbackDetail
      };
    }
    case "app_update_available":
      return {
        title: t("notifications.app_update_available.title"),
        detail: t("notifications.app_update_available.detail", {
          current: data.current_version || notification.source?.update?.current_version || "",
          latest: data.latest_version || notification.source?.update?.latest_version || ""
        })
      };
    default:
      return fallback;
  }
}

export function formatApiError(error, t, fallbackKey = "system:errors.unknown") {
  const code = text(error?.code || error?.data?.code || error?.reason || error?.data?.reason);
  if (code) {
    const translated = t(`system:errors.${code}`, {
      ...error?.data,
      defaultValue: ""
    });
    if (text(translated)) return translated;
  }
  return text(error?.message) || t(fallbackKey);
}
