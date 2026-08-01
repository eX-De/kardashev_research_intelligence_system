import assert from "node:assert/strict";
import test from "node:test";

import {
  paperImportNotificationFromJob,
  paperImportNotificationToastType
} from "../../src/lib/paperImportNotifications.js";

test("paper import completion creates the same stable semantic toast id as the worker event", () => {
  const notification = paperImportNotificationFromJob({
    id: 50,
    job_type: "reader-import-url",
    import_type: "url",
    status: "completed",
    imported_count: 1,
    error_count: 0
  });
  assert.deepEqual(notification, {
    channels: ["toast"],
    data: {
      error_count: 0,
      error_message: "",
      import_type: "url",
      imported_count: 1
    },
    id: "reader-import-url-completed-50",
    requires_action: false,
    severity: "ok",
    type: "reader_import_completed"
  });
  assert.equal(paperImportNotificationToastType(notification), "success");
});

test("paper import failures and partial results use error and warning toast tones", () => {
  const failed = paperImportNotificationFromJob({
    id: 51,
    job_type: "reader-import-upload",
    status: "failed",
    error_message: "Invalid PDF"
  });
  assert.equal(failed.id, "reader-import-upload-failed-51");
  assert.equal(failed.data.import_type, "upload");
  assert.equal(paperImportNotificationToastType(failed), "error");

  const partial = paperImportNotificationFromJob({
    id: 52,
    job_type: "reader-import-web",
    status: "completed",
    imported_count: 1,
    error_count: 1
  });
  assert.equal(partial.severity, "warn");
  assert.equal(paperImportNotificationToastType(partial), "warning");
  assert.equal(paperImportNotificationFromJob({ id: 53, status: "running" }), null);
});
