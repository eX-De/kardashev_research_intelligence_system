import assert from "node:assert/strict";
import test from "node:test";

import { setPoolForTesting, toJson, ValidationError } from "../../server/db.js";
import { insertAppEvent, listUnpublishedAppEvents, markAppEventsPublished } from "../../server/outbox.js";

function createOutboxPool() {
  const events = [];
  return {
    events,
    pool: {
      async query(sql, params = []) {
        const normalized = String(sql).replace(/\s+/g, " ").trim().toUpperCase();
        if (normalized.startsWith("INSERT INTO APP_EVENTS")) {
          const row = {
            id: String(events.length + 1),
            event_type: params[0],
            payload_json: params[1],
            created_at: params[2],
            published_at: null
          };
          events.push(row);
          return { rows: [row] };
        }
        if (normalized.includes("FROM APP_EVENTS") && normalized.includes("PUBLISHED_AT IS NULL")) {
          return {
            rows: events
              .filter((event) => !event.published_at)
              .slice(0, Number(params[0] || 0))
          };
        }
        if (normalized.startsWith("UPDATE APP_EVENTS SET PUBLISHED_AT = $1")) {
          const ids = new Set(params[1].map((id) => Number(id)));
          const rows = [];
          for (const event of events) {
            if (ids.has(Number(event.id)) && !event.published_at) {
              event.published_at = params[0];
              rows.push({ id: event.id });
            }
          }
          return { rows };
        }
        throw new Error(`Unexpected SQL in outbox test: ${sql}`);
      }
    }
  };
}

async function withOutboxPool(fn) {
  const fake = createOutboxPool();
  setPoolForTesting(fake.pool);
  try {
    return await fn(fake);
  } finally {
    setPoolForTesting(null);
  }
}

test("insertAppEvent and listUnpublishedAppEvents preserve event payload shape", async () => {
  await withOutboxPool(async () => {
    const inserted = await insertAppEvent(
      "daily_run_progress.updated",
      { progress: { current: 1 } },
      { createdAt: "2026-07-06T10:00:00.000Z" }
    );
    assert.deepEqual(inserted, {
      id: 1,
      event_type: "daily_run_progress.updated",
      payload: { progress: { current: 1 } },
      created_at: "2026-07-06T10:00:00.000Z",
      published_at: null
    });
    assert.deepEqual(await listUnpublishedAppEvents(10), [inserted]);
  });
});

test("markAppEventsPublished marks only unpublished ids once", async () => {
  await withOutboxPool(async (fake) => {
    await insertAppEvent("task.finished", { task: { id: 1 } }, { createdAt: "2026-07-06T10:00:00.000Z" });
    await insertAppEvent("task.failed", { task: { id: 2 } }, { createdAt: "2026-07-06T10:01:00.000Z" });
    assert.deepEqual(await markAppEventsPublished([1, 2, 2], { publishedAt: "2026-07-06T10:02:00.000Z" }), {
      published: [1, 2]
    });
    assert.deepEqual(await markAppEventsPublished([1], { publishedAt: "2026-07-06T10:03:00.000Z" }), {
      published: []
    });
    assert.deepEqual(await listUnpublishedAppEvents(10), []);
    assert.equal(fake.events[0].published_at, "2026-07-06T10:02:00.000Z");
  });
});

test("outbox validation rejects invalid event protocol fields", async () => {
  await assert.rejects(() => insertAppEvent("", {}), ValidationError);
  await assert.rejects(() => listUnpublishedAppEvents(0), ValidationError);
  await assert.rejects(() => markAppEventsPublished(["bad"]), ValidationError);
  assert.equal(toJson({ b: 2, a: 1 }), '{"a": 1, "b": 2}');
});
