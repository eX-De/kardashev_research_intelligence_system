import { randomUUID } from "node:crypto";
import { envValue, positiveInteger } from "./env.js";

const DEFAULT_COMPUTE_URL = "http://127.0.0.1:8765";

export class ComputeClientError extends Error {
  constructor(message, { code = "compute_failed", statusCode = 502, requestId = "", cause } = {}) {
    super(message, { cause });
    this.name = "ComputeClientError";
    this.code = code;
    this.statusCode = statusCode;
    this.requestId = requestId;
  }
}

function requestConfig(options = {}) {
  const baseUrl = String(options.baseUrl || envValue("KRIS_COMPUTE_URL", DEFAULT_COMPUTE_URL)).replace(/\/+$/, "");
  const token = String(options.token ?? envValue("KRIS_COMPUTE_TOKEN", ""));
  if (!token) throw new ComputeClientError("Compute service token is not configured", { code: "compute_token_missing", statusCode: 503 });
  return {
    baseUrl,
    token,
    timeoutMs: positiveInteger(options.timeoutMs || process.env.KRIS_COMPUTE_TIMEOUT_MS, 210000),
    fetchImpl: options.fetchImpl || fetch
  };
}

function abortContext(signal, timeoutMs) {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(new Error("Compute service request timed out")), timeoutMs);
  timer.unref?.();
  return {
    signal: signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal,
    callerSignal: signal,
    timeoutSignal: timeoutController.signal,
    cleanup() { clearTimeout(timer); }
  };
}

async function errorFromResponse(response, requestId) {
  let data = {};
  try { data = await response.json(); } catch { /* use status text */ }
  return new ComputeClientError(data.error || response.statusText || "Compute service request failed", {
    code: data.code || "compute_failed",
    statusCode: response.status >= 400 && response.status < 500 ? response.status : 502,
    requestId
  });
}

export function createComputeClient(options = {}) {
  const config = requestConfig(options);

  async function cancel(requestId) {
    try {
      await config.fetchImpl(`${config.baseUrl}/v1/requests/${encodeURIComponent(requestId)}/cancel`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${config.token}`, "x-request-id": randomUUID() },
        signal: AbortSignal.timeout(3000)
      });
    } catch {
      // The original connection closing also signals cancellation to streaming handlers.
    }
  }

  async function request(path, body, { signal, requestId = randomUUID(), stream = false, timeoutMs = config.timeoutMs } = {}) {
    const abort = abortContext(signal, timeoutMs);
    const onAbort = () => {
      void cancel(requestId);
    };
    abort.signal.addEventListener("abort", onAbort, { once: true });
    let keepLifecycle = false;
    try {
      const response = await config.fetchImpl(`${config.baseUrl}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.token}`,
          "content-type": "application/json",
          "x-request-id": requestId
        },
        body: JSON.stringify(body || {}),
        signal: abort.signal
      });
      if (!response.ok) throw await errorFromResponse(response, requestId);
      if (stream) {
        keepLifecycle = true;
        return { response, abort, onAbort, requestId };
      }
      return await response.json();
    } catch (error) {
      if (abort.timeoutSignal.aborted) {
        throw new ComputeClientError("Compute service request timed out", { code: "compute_timeout", statusCode: 504, requestId, cause: error });
      }
      if (abort.callerSignal?.aborted) {
        throw new ComputeClientError("Compute service request was cancelled", { code: "compute_cancelled", statusCode: 499, requestId, cause: error });
      }
      if (error instanceof ComputeClientError) throw error;
      throw new ComputeClientError(`Compute service is unavailable: ${error.message}`, { code: "compute_unavailable", statusCode: 503, requestId, cause: error });
    } finally {
      if (!keepLifecycle) {
        abort.signal.removeEventListener("abort", onAbort);
        abort.cleanup();
      }
    }
  }

  return {
    deepSearch(body, options) {
      return request("/v1/search/deep", body, options);
    },
    readerFollowups(paperId, body, options) {
      return request(`/v1/reader/papers/${encodeURIComponent(String(paperId))}/followups`, body, options);
    },
    async streamReaderChat(paperId, body, onEvent, options = {}) {
      const lifecycle = await request(`/v1/reader/papers/${encodeURIComponent(String(paperId))}/chat`, body, { ...options, stream: true });
      const { response, abort, onAbort, requestId } = lifecycle;
      const decoder = new TextDecoder();
      let buffer = "";
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newline = buffer.indexOf("\n");
          while (newline !== -1) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line) onEvent(JSON.parse(line));
            newline = buffer.indexOf("\n");
          }
        }
        buffer += decoder.decode();
        if (buffer.trim()) onEvent(JSON.parse(buffer));
      } catch (error) {
        if (abort.timeoutSignal.aborted) {
          throw new ComputeClientError("Compute service request timed out", { code: "compute_timeout", statusCode: 504, requestId, cause: error });
        }
        if (abort.callerSignal?.aborted) {
          throw new ComputeClientError("Compute service request was cancelled", { code: "compute_cancelled", statusCode: 499, requestId, cause: error });
        }
        throw error;
      } finally {
        await reader.cancel().catch(() => {});
        abort.signal.removeEventListener("abort", onAbort);
        abort.cleanup();
        await cancel(requestId);
      }
    },
    cancel
  };
}
