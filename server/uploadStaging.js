import Busboy from "busboy";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const DEFAULT_READER_UPLOAD_MAX_FILE_BYTES = 128 * 1024 * 1024;
export const DEFAULT_READER_UPLOAD_MAX_FILES = 10;

export class ReaderUploadError extends Error {
  constructor(message, { statusCode = 400, code = "reader_upload_invalid" } = {}) {
    super(message);
    this.name = "ReaderUploadError";
    this.statusCode = statusCode;
    this.structuredCode = code;
  }
}

function positiveLimit(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function safeFilename(value) {
  const normalized = String(value || "")
    .replaceAll("\0", "")
    .replaceAll("\\", "/")
    .trim();
  return basename(normalized).slice(0, 255) || "uploaded.pdf";
}

function isPdfPrefix(prefix) {
  return prefix.length >= 5 && prefix.subarray(0, 5).equals(Buffer.from("%PDF-"));
}

function requestContentType(req) {
  return String(req?.headers?.["content-type"] || "");
}

function uploadErrorFrom(error) {
  if (error instanceof ReaderUploadError) return error;
  return new ReaderUploadError("Unable to save the PDF upload.", {
    statusCode: 500,
    code: "reader_upload_staging_failed"
  });
}

function multipartFinished(req, parser) {
  return new Promise((resolvePromise, rejectPromise) => {
    let finished = false;
    const settle = (callback, value) => {
      if (finished) return;
      finished = true;
      req.removeListener?.("error", onRequestError);
      req.removeListener?.("aborted", onRequestAborted);
      parser.removeListener("error", onParserError);
      callback(value);
    };
    const onParserError = (error) => settle(rejectPromise, uploadErrorFrom(error));
    const onRequestError = (error) => settle(rejectPromise, uploadErrorFrom(error));
    const onRequestAborted = () => settle(rejectPromise, new ReaderUploadError("PDF upload was interrupted.", {
      statusCode: 400,
      code: "reader_upload_aborted"
    }));

    parser.once("close", () => settle(resolvePromise));
    parser.once("error", onParserError);
    req.once?.("error", onRequestError);
    req.once?.("aborted", onRequestAborted);
    req.pipe(parser);
  });
}

function stagedPathsFrom(files) {
  return [...new Set((files || [])
    .map((file) => typeof file === "string" ? file : file?.staged_path)
    .filter(Boolean))];
}

export function readerUploadStagingDirectory(pdfDirectory) {
  return resolve(String(pdfDirectory || "./data/arxiv_pdfs"), ".reader-upload-staging");
}

export async function discardStagedReaderUploads(files) {
  await Promise.all(stagedPathsFrom(files).map(async (filePath) => {
    try {
      await unlink(filePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }));
}

export async function stageReaderPdfUploads(req, {
  pdfDirectory,
  stagingDirectory = readerUploadStagingDirectory(pdfDirectory),
  maxFileBytes = DEFAULT_READER_UPLOAD_MAX_FILE_BYTES,
  maxFiles = DEFAULT_READER_UPLOAD_MAX_FILES
} = {}) {
  if (!/^multipart\/form-data(?:;|$)/i.test(requestContentType(req))) {
    throw new ReaderUploadError("PDF uploads require multipart/form-data.", {
      statusCode: 415,
      code: "reader_upload_content_type"
    });
  }

  const fileLimit = positiveLimit(maxFileBytes, DEFAULT_READER_UPLOAD_MAX_FILE_BYTES);
  const countLimit = positiveLimit(maxFiles, DEFAULT_READER_UPLOAD_MAX_FILES);
  const directory = resolve(stagingDirectory);
  await mkdir(directory, { recursive: true });

  let parser;
  try {
    parser = Busboy({
      headers: req.headers,
      limits: {
        fileSize: fileLimit,
        files: countLimit,
        fields: 0
      }
    });
  } catch {
    throw new ReaderUploadError("Malformed multipart PDF upload.", {
      statusCode: 400,
      code: "reader_upload_multipart_invalid"
    });
  }

  const stagedFiles = [];
  const createdPaths = [];
  const fileTasks = [];
  let parserError = null;
  const captureError = (error) => {
    if (!parserError) parserError = error;
  };

  parser.on("file", (fieldName, stream, info) => {
    if (fieldName !== "files") {
      stream.resume();
      captureError(new ReaderUploadError("Unexpected multipart field in PDF upload.", {
        statusCode: 400,
        code: "reader_upload_field_invalid"
      }));
      return;
    }

    const stagedPath = join(directory, `${randomUUID()}.upload`);
    const hash = createHash("sha256");
    let sizeBytes = 0;
    let prefix = Buffer.alloc(0);
    const inspector = new Transform({
      transform(chunk, _encoding, callback) {
        const content = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        sizeBytes += content.length;
        hash.update(content);
        if (prefix.length < 5) {
          prefix = Buffer.concat([prefix, content.subarray(0, 5 - prefix.length)]);
        }
        callback(null, content);
      }
    });

    createdPaths.push(stagedPath);
    stream.once("limit", () => {
      captureError(new ReaderUploadError(`Each PDF must be no larger than ${fileLimit} bytes.`, {
        statusCode: 413,
        code: "reader_upload_file_too_large"
      }));
    });
    fileTasks.push(
      pipeline(stream, inspector, createWriteStream(stagedPath, { flags: "wx" }))
        .then(() => {
          if (stream.truncated) {
            throw new ReaderUploadError(`Each PDF must be no larger than ${fileLimit} bytes.`, {
              statusCode: 413,
              code: "reader_upload_file_too_large"
            });
          }
          if (!isPdfPrefix(prefix)) {
            throw new ReaderUploadError("Uploaded file does not look like a PDF.", {
              statusCode: 400,
              code: "reader_upload_not_pdf"
            });
          }
          stagedFiles.push({
            filename: safeFilename(info?.filename),
            staged_path: stagedPath,
            size_bytes: sizeBytes,
            sha256: hash.digest("hex")
          });
        })
    );
  });
  parser.on("filesLimit", () => {
    captureError(new ReaderUploadError(`Upload supports at most ${countLimit} PDF files.`, {
      statusCode: 413,
      code: "reader_upload_file_count_exceeded"
    }));
  });
  parser.on("fieldsLimit", () => {
    captureError(new ReaderUploadError("PDF uploads do not accept form fields.", {
      statusCode: 400,
      code: "reader_upload_field_invalid"
    }));
  });

  try {
    await multipartFinished(req, parser);
    const taskResults = await Promise.allSettled(fileTasks);
    const failedTask = taskResults.find((result) => result.status === "rejected");
    if (parserError) throw parserError;
    if (failedTask?.status === "rejected") throw uploadErrorFrom(failedTask.reason);
    if (!stagedFiles.length) {
      throw new ReaderUploadError("Select at least one PDF to upload.", {
        statusCode: 400,
        code: "reader_upload_empty"
      });
    }
    return { files: stagedFiles, staging_directory: directory };
  } catch (error) {
    await Promise.allSettled(fileTasks);
    await discardStagedReaderUploads(createdPaths);
    throw uploadErrorFrom(error);
  }
}
