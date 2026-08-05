import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { createComputeClient } from "../../server/computeClient.js";


async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("compute client sends service identity and request id for deep search", async () => {
  await withServer((req, res) => {
    assert.equal(req.url, "/v1/search/deep");
    assert.equal(req.headers.authorization, "Bearer test-token");
    assert.equal(req.headers["x-request-id"], "deep.req-1");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ mode: "deep", results: [], stats: {} }));
  }, async (baseUrl) => {
    const client = createComputeClient({ baseUrl, token: "test-token", timeoutMs: 1000 });
    const result = await client.deepSearch({ query: "retrieval" }, { requestId: "deep.req-1" });
    assert.equal(result.mode, "deep");
  });
});

test("stream cancellation closes the reader and calls the cancel endpoint", async () => {
  let cancelledRequestId = "";
  let streamClosed = false;
  await withServer((req, res) => {
    if (req.method === "DELETE") {
      cancelledRequestId = decodeURIComponent(req.url.split("/")[3]);
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
      return;
    }
    req.resume();
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    res.write('{"event":"start","data":{}}\n');
    req.on("close", () => { streamClosed = true; });
  }, async (baseUrl) => {
    const controller = new AbortController();
    const client = createComputeClient({ baseUrl, token: "test-token", timeoutMs: 2000 });
    const promise = client.streamReaderChat(5, { message: "why" }, () => controller.abort(), {
      requestId: "chat.req-1",
      signal: controller.signal
    });
    await assert.rejects(promise, (error) => error.code === "compute_cancelled" && error.statusCode === 499);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(cancelledRequestId, "chat.req-1");
    assert.equal(streamClosed, true);
  });
});

test("compute timeout is distinct from caller cancellation", async () => {
  await withServer((req, res) => {
    if (req.method === "DELETE") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    }
  }, async (baseUrl) => {
    const client = createComputeClient({ baseUrl, token: "test-token", timeoutMs: 30 });
    await assert.rejects(
      client.deepSearch({ query: "slow" }, { requestId: "deep.timeout" }),
      (error) => error.code === "compute_timeout" && error.statusCode === 504
    );
  });
});
