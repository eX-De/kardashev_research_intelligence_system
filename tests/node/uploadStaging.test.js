import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import {
  discardStagedReaderUploads,
  stageReaderPdfUploads
} from "../../server/uploadStaging.js";

function multipartRequest(files) {
  const boundary = "----reader-upload-test-boundary";
  const chunks = [];
  for (const file of files) {
    chunks.push(Buffer.from(
      `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="${file.field || "files"}"; filename="${file.filename}"\r\n`
      + "Content-Type: application/pdf\r\n\r\n"
    ));
    chunks.push(Buffer.from(file.content));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  const request = Readable.from([Buffer.concat(chunks)]);
  request.headers = { "content-type": `multipart/form-data; boundary=${boundary}` };
  return request;
}

test("stageReaderPdfUploads streams a PDF to staging and returns only metadata", async () => {
  const stagingDirectory = await mkdtemp(join(tmpdir(), "reader-upload-staging-"));
  const pdf = Buffer.from("%PDF-1.7\nstreamed reader import");
  try {
    const staged = await stageReaderPdfUploads(multipartRequest([
      { filename: "paper.pdf", content: pdf }
    ]), { stagingDirectory, maxFileBytes: 1024, maxFiles: 2 });

    assert.equal(staged.files.length, 1);
    assert.equal(staged.files[0].filename, "paper.pdf");
    assert.equal(staged.files[0].size_bytes, pdf.length);
    assert.equal(staged.files[0].sha256, createHash("sha256").update(pdf).digest("hex"));
    assert.deepEqual(await readFile(staged.files[0].staged_path), pdf);

    await discardStagedReaderUploads(staged.files);
    assert.deepEqual(await readdir(stagingDirectory), []);
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
});

test("stageReaderPdfUploads rejects non-PDF input and removes the temporary file", async () => {
  const stagingDirectory = await mkdtemp(join(tmpdir(), "reader-upload-staging-"));
  try {
    await assert.rejects(
      stageReaderPdfUploads(multipartRequest([
        { filename: "not-a-pdf.pdf", content: Buffer.from("plain text") }
      ]), { stagingDirectory, maxFileBytes: 1024, maxFiles: 2 }),
      (error) => error?.structuredCode === "reader_upload_not_pdf" && error?.statusCode === 400
    );
    assert.deepEqual(await readdir(stagingDirectory), []);
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
});
