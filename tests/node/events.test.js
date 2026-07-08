import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  SERVER_EVENTS,
  compactProjectChangedPayload,
  compactTaskEventPayload,
  createEventPublisher
} from "../../server/events.js";

function createPublisher() {
  return createEventPublisher({
    heartbeatMs: 1000,
    dailyProgressThrottleMs: 0,
    getSchedulerStatus: () => ({
      enabled: true,
      current_job: { command: "run-daily", status: "running", args: ["--x"] },
      last_job: null,
      paper_report_queue: {
        active_jobs: [{ command: "generate-paper-reports", status: "running" }]
      }
    })
  });
}

test("publishEvent returns wrapped SSE payload with stable JSON type field", () => {
  const publisher = createPublisher();
  const event = publisher.publishEvent("bad event name!", { ok: true });

  assert.equal(event.type, "bad_event_name_");
  assert.deepEqual(event.data, { ok: true });
  assert.equal(typeof event.id, "number");
  assert.ok(event.emitted_at);
});

test("openEventStream sends named SSE event whose data JSON includes type", () => {
  const publisher = createPublisher();
  const req = new EventEmitter();
  req.socket = {
    setTimeout() {},
    setKeepAlive() {}
  };
  const writes = [];
  const res = {
    writableEnded: false,
    destroyed: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    flushHeaders() {},
    write(chunk) {
      writes.push(String(chunk));
      return true;
    }
  };

  publisher.openEventStream(req, res);
  req.emit("close");

  assert.equal(res.status, 200);
  const payload = writes.join("");
  assert.match(payload, /event: events\.connected/);
  const dataLine = payload.split(/\r?\n/).find((line) => line.startsWith("data: "));
  const parsed = JSON.parse(dataLine.slice("data: ".length));
  assert.equal(parsed.type, SERVER_EVENTS.EVENTS_CONNECTED);
  assert.equal(parsed.data.client_id.length > 0, true);
});

test("publishSettingsChanged compacts scheduler payload", () => {
  const publisher = createPublisher();
  const event = publisher.publishSettingsChanged({}, undefined);

  assert.equal(event.type, SERVER_EVENTS.SETTINGS_CHANGED);
  assert.deepEqual(event.data.scheduler.current_job, {
    id: null,
    command: "run-daily",
    source: null,
    args: ["--x"],
    status: "running",
    started_at: null,
    finished_at: null,
    message: null
  });
  assert.equal(event.data.scheduler.paper_report_queue.active_jobs[0].command, "generate-paper-reports");
});

test("publishProjectChanged and publishPaperChanged preserve frontend id fields", () => {
  const publisher = createPublisher();
  const projectEvent = publisher.publishProjectChanged(
    SERVER_EVENTS.PROJECT_UPDATED,
    { project: { id: 7, name: "Demo", status: "active", updated_at: "now" } }
  );
  const paperEvent = publisher.publishPaperChanged(
    SERVER_EVENTS.PAPER_LIBRARY_STATUS_UPDATED,
    {
      paper: { id: 3, arxiv_id: "2601.00001", library_status: "saved" },
      project_ids: [7],
      linked_projects: [{ project_id: 8 }]
    }
  );

  assert.equal(projectEvent.data.project_id, 7);
  assert.equal(projectEvent.data.project.id, 7);
  assert.equal(paperEvent.data.paper_id, 3);
  assert.deepEqual(paperEvent.data.project_ids, [7, 8]);
});

test("durable payload builders match EventPublisher compact payloads", () => {
  const publisher = createPublisher();
  const projectData = { project: { id: 7, name: "Demo", status: "active", updated_at: "now" } };
  const projectEvent = publisher.publishProjectChanged(SERVER_EVENTS.PROJECT_UPDATED, projectData);
  assert.deepEqual(projectEvent.data, compactProjectChangedPayload(projectData));

  const job = { id: 3, command: "generate-reports", source: "manual", args: [], status: "queued" };
  const taskEvent = publisher.publishTaskEvent(SERVER_EVENTS.TASK_STARTED, job, { status: "queued" });
  assert.deepEqual(taskEvent.data.task, compactTaskEventPayload(job, { status: "queued" }).task);
});

test("publishTaskEvent carries scheduler and compact task result", () => {
  const publisher = createPublisher();
  const event = publisher.publishTaskEvent(
    SERVER_EVENTS.TASK_FINISHED,
    { command: "sync-obsidian", source: "manual", status: "completed" },
    { result: { ok: true, message: "done", ignored: "large" } }
  );

  assert.equal(event.type, SERVER_EVENTS.TASK_FINISHED);
  assert.equal(event.data.task.command, "sync-obsidian");
  assert.deepEqual(event.data.task.result, { ok: true, message: "done" });
  assert.equal(event.data.scheduler.enabled, true);
});
