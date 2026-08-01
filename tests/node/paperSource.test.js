import assert from "node:assert/strict";
import test from "node:test";

import {
  isRecentManualPaperImport,
  RECENT_MANUAL_IMPORT_WINDOW_MS
} from "../../src/lib/paperSource.js";

const NOW = Date.parse("2026-07-21T12:00:00Z");

test("recent import marker uses the latest manual import time within thirty minutes", () => {
  assert.equal(isRecentManualPaperImport({ source: "manual", last_imported_at: new Date(NOW - 1_000).toISOString(), created_at: "2020-01-01T00:00:00Z" }, NOW), true);
  assert.equal(isRecentManualPaperImport({ source: "manual", last_imported_at: new Date(NOW - RECENT_MANUAL_IMPORT_WINDOW_MS).toISOString() }, NOW), true);
  assert.equal(isRecentManualPaperImport({ source: "manual", last_imported_at: new Date(NOW - RECENT_MANUAL_IMPORT_WINDOW_MS - 1).toISOString() }, NOW), false);
  assert.equal(isRecentManualPaperImport({ source: "manual", created_at: new Date(NOW - 1_000).toISOString() }, NOW), true);
  assert.equal(isRecentManualPaperImport({ source: "daily", created_at: new Date(NOW - 1_000).toISOString() }, NOW), false);
  assert.equal(isRecentManualPaperImport({ source: "manual", last_imported_at: "invalid" }, NOW), false);
});
