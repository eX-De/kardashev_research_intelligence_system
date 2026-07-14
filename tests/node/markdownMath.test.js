import assert from "node:assert/strict";
import test from "node:test";

import { normalizeMathDelimiters } from "../../src/lib/markdownMath.js";

test("normalizeMathDelimiters preserves display-math dollar delimiters", () => {
  const source = String.raw`Before

\[
\text{logit\_lens}(h_\ell) = \text{softmax}(W_U \cdot \text{norm}(h_\ell))
\]

After`;

  const normalized = normalizeMathDelimiters(source);

  assert.match(
    normalized,
    /\$\$\n\n\\text\{logit\\_lens\}\(h_\\ell\) = \\text\{softmax\}\(W_U \\cdot \\text\{norm\}\(h_\\ell\)\)\n\n\$\$/
  );
  assert.doesNotMatch(normalized, /(?:^|\n)\$(?:\n|$)/);
});

test("normalizeMathDelimiters converts inline math without losing delimiters", () => {
  assert.equal(
    normalizeMathDelimiters(String.raw`Result: \(a+b\).`),
    "Result: $a+b$."
  );
});

test("normalizeMathDelimiters leaves fenced code unchanged", () => {
  const source = [
    String.raw`\(outside\)`,
    "",
    "```text",
    String.raw`\[inside\]`,
    String.raw`\(inside\)`,
    "```"
  ].join("\n");

  assert.equal(
    normalizeMathDelimiters(source),
    [
      "$outside$",
      "",
      "```text",
      String.raw`\[inside\]`,
      String.raw`\(inside\)`,
      "```"
    ].join("\n")
  );
});
