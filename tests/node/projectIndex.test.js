import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildProjectIndexDocument } from "../../server/projectIndex.js";

test("Node project-index rendering matches the frozen document contract", async () => {
  const fixture = JSON.parse(await readFile(new URL("../fixtures/project-index-contract.json", import.meta.url), "utf8"));
  assert.equal(fixture.renderer, "server.projectIndex.buildProjectIndexDocument");
  assert.deepEqual(buildProjectIndexDocument(fixture.input), fixture.expected);
  assert.deepEqual(buildProjectIndexDocument(fixture.empty_input), fixture.empty_expected);
});
