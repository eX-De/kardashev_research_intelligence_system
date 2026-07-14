import assert from "node:assert/strict";
import test from "node:test";

import { api } from "../../src/lib/dashboard.js";

test("api leaves multipart content type to fetch", async () => {
  const originalFetch = globalThis.fetch;
  let requestOptions = null;
  globalThis.fetch = async (_path, options) => {
    requestOptions = options;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  try {
    const formData = new FormData();
    formData.append("files", new Blob(["%PDF-1.7"]), "paper.pdf");
    await api("/api/reader/papers/upload", { method: "POST", body: formData });
    assert.equal(requestOptions.headers.has("content-type"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
