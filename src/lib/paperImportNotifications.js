const TERMINAL_IMPORT_STATUSES = new Set(["completed", "failed", "cancelled"]);

function text(value) {
  return String(value ?? "").trim();
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function importType(job = {}) {
  const explicit = text(job.import_type);
  if (explicit) return explicit;
  if (job.job_type === "reader-import-upload") return "upload";
  if (job.job_type === "reader-import-web") return "web";
  return "url";
}

export function paperImportNotificationFromJob(job) {
  const status = text(job?.status);
  const jobId = number(job?.id);
  if (!jobId || !TERMINAL_IMPORT_STATUSES.has(status)) return null;

  const jobType = text(job.job_type) || `reader-import-${importType(job)}`;
  const failed = status === "failed" || status === "cancelled";
  const importedCount = number(job.imported_count);
  const errorCount = number(job.error_count);
  return {
    channels: ["toast"],
    data: {
      error_count: errorCount,
      error_message: text(job.error_message),
      import_type: importType(job),
      imported_count: importedCount
    },
    id: `${jobType}-${failed ? "failed" : "completed"}-${jobId}`,
    requires_action: false,
    severity: failed ? "bad" : errorCount ? "warn" : "ok",
    type: failed ? "reader_import_failed" : "reader_import_completed"
  };
}

export function paperImportNotificationToastType(notification) {
  const severity = text(notification?.severity).toLowerCase();
  if (severity === "bad" || severity === "error") return "error";
  if (severity === "warn" || severity === "warning") return "warning";
  if (severity === "ok" || severity === "success") return "success";
  return "info";
}
