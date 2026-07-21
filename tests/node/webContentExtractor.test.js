import assert from "node:assert/strict";
import test from "node:test";

import { assertSafeWebUrl, extractReadableContent } from "../../scripts/extract-web-content.mjs";


test("Readability extracts article content and discards page chrome and scripts", () => {
  const paragraph = "A unified retrieval system should preserve document scope while combining lexical and semantic evidence. ".repeat(4);
  const result = extractReadableContent(
    `<!doctype html>
      <html lang="en">
        <head><title>Fallback title</title></head>
        <body>
          <nav>Navigation noise that must not be imported</nav>
          <main>
            <article>
              <h1>Useful research article</h1>
              <p>${paragraph}</p>
              <p>${paragraph}</p>
              <script>window.privateToken = "do-not-store";</script>
            </article>
          </main>
        </body>
      </html>`,
    "https://example.com/research/article",
  );

  assert.equal(result.extraction_method, "static");
  assert.match(result.markdown, /Useful research article/);
  assert.match(result.markdown, /unified retrieval system/);
  assert.doesNotMatch(result.markdown, /Navigation noise/);
  assert.doesNotMatch(result.markdown, /privateToken|script/i);
});


test("web import rejects loopback and non-standard ports", async () => {
  await assert.rejects(() => assertSafeWebUrl("http://127.0.0.1/article"), /私网|保留地址/);
  await assert.rejects(() => assertSafeWebUrl("https://example.com:8443/article"), /标准 HTTP\/HTTPS 端口/);
});
