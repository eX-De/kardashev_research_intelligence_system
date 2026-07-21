import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { api, postJson } from "../lib/dashboard.js";
import "../styles/GlobalSearchDialog.css";

const MODE_KEY = "kris.unified-search.mode";
const TYPE_OPTIONS = [
  ["all", "全部"],
  ["paper", "论文"],
  ["artifact", "产物"],
  ["project", "项目"]
];
const ENTITY_LABELS = { paper: "论文", artifact: "产物", project: "项目" };
const SOURCE_LABELS = {
  paper: "论文文本",
  paper_abstract: "标题与摘要",
  paper_chunk: "论文全文",
  daily_report: "日报",
  experiment_report: "实验报告",
  project_chat_profile: "项目 Chat 摘要",
  project: "项目字段"
};

function initialDeepSearch() {
  if (typeof window === "undefined") return false;
  return window.sessionStorage.getItem(MODE_KEY) === "deep";
}

function escapedPattern(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function Highlight({ query, text }) {
  const value = String(text || "");
  if (!query.trim()) return value;
  const parts = value.split(new RegExp(`(${escapedPattern(query.trim())})`, "ig"));
  return parts.map((part, index) => (
    part.toLowerCase() === query.trim().toLowerCase()
      ? <mark key={`${part}-${index}`}>{part}</mark>
      : part
  ));
}

function resultMeta(result) {
  const bits = [ENTITY_LABELS[result.entity_type] || result.entity_type];
  const source = SOURCE_LABELS[result.source_type] || result.source_type;
  if (source) bits.push(source);
  if (Number.isFinite(Number(result.score))) bits.push(`相关度 ${Math.round(Number(result.score) * 100)}%`);
  return bits.join(" · ");
}

function BrainIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.65">
      <path d="M9.5 4.5A3 3 0 0 0 4 6.2a3.2 3.2 0 0 0 .7 6.2A3.5 3.5 0 0 0 9.5 18" />
      <path d="M14.5 4.5A3 3 0 0 1 20 6.2a3.2 3.2 0 0 1-.7 6.2 3.5 3.5 0 0 1-4.8 5.6" />
      <path d="M9.5 4.5V19a2.5 2.5 0 0 0 5 0V4.5M7 8.5h2.5M17 8.5h-2.5M6.5 14h3M17.5 14h-3" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8">
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.5 15.5 5 5" />
    </svg>
  );
}

export function GlobalSearchDialog({ isOpen, onClose, onOpen, setStatusMessage }) {
  const [isRendered, setIsRendered] = useState(isOpen);
  const [isClosing, setIsClosing] = useState(false);
  const [query, setQuery] = useState("");
  const [deepSearch, setDeepSearch] = useState(initialDeepSearch);
  const [activeType, setActiveType] = useState("all");
  const [response, setResponse] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [job, setJob] = useState(null);
  const inputRef = useRef(null);
  const pollTimer = useRef(null);
  const requestToken = useRef(0);
  const returnFocusTarget = useRef(null);

  const results = useMemo(() => {
    const items = response?.results || [];
    return activeType === "all" ? items : items.filter((item) => item.entity_type === activeType);
  }, [activeType, response]);

  const pollDeepJob = useCallback(async (workerJobId, token) => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    try {
      const data = await api(`/api/search/jobs/${encodeURIComponent(String(workerJobId))}`);
      if (token !== requestToken.current) return;
      setJob((current) => ({ ...current, ...data, requestToken: token }));
      if (data.status === "completed") {
        setResponse(data.result || { mode: "deep", results: [], stats: {} });
        setBusy(false);
        setStatusMessage?.("深度搜索完成");
        return;
      }
      if (data.status === "failed") {
        throw new Error(data.error || "深度搜索失败");
      }
      pollTimer.current = setTimeout(() => pollDeepJob(workerJobId, token), 800);
    } catch (nextError) {
      if (token !== requestToken.current) return;
      setBusy(false);
      setError(nextError.message);
      setStatusMessage?.(nextError.message);
    }
  }, [setStatusMessage]);

  useEffect(() => () => {
    requestToken.current += 1;
    if (pollTimer.current) clearTimeout(pollTimer.current);
  }, []);

  useEffect(() => {
    if (isOpen) {
      setIsRendered(true);
      setIsClosing(false);
      return undefined;
    }
    if (!isRendered) return undefined;

    setIsClosing(true);
    const timer = window.setTimeout(() => {
      setIsRendered(false);
      setIsClosing(false);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [isOpen, isRendered]);

  useEffect(() => {
    const handleShortcut = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onOpen();
      } else if (event.key === "Escape" && isOpen) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [isOpen, onClose, onOpen]);

  useEffect(() => {
    if (!isOpen) return undefined;
    returnFocusTarget.current = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      returnFocusTarget.current?.focus?.();
    };
  }, [isOpen]);

  useEffect(() => {
    const workerJobId = job?.worker_job_id;
    const token = job?.requestToken;
    if (!workerJobId || !token || ["completed", "failed"].includes(job?.status) || typeof window.EventSource !== "function") return undefined;
    const source = new window.EventSource("/api/events");
    const handle = (event) => {
      try {
        const envelope = JSON.parse(event.data);
        const data = envelope?.data || {};
        if (Number(data.worker_job_id || data.task?.worker_job_id) === Number(workerJobId)) {
          pollDeepJob(workerJobId, token);
        }
      } catch {
        // Timed polling remains the fallback for malformed or unrelated events.
      }
    };
    source.addEventListener("search.completed", handle);
    source.addEventListener("task.failed", handle);
    return () => source.close();
  }, [job?.requestToken, job?.status, job?.worker_job_id, pollDeepJob]);

  function toggleDeepSearch() {
    const nextValue = !deepSearch;
    setDeepSearch(nextValue);
    window.sessionStorage.setItem(MODE_KEY, nextValue ? "deep" : "quick");
  }

  async function runSearch(value, useDeepSearch) {
    if (!value) {
      setError("请输入搜索内容");
      inputRef.current?.focus();
      return;
    }

    const token = requestToken.current + 1;
    requestToken.current = token;
    if (pollTimer.current) clearTimeout(pollTimer.current);
    setBusy(true);
    setError("");
    setResponse(null);
    setJob(null);
    setActiveType("all");

    try {
      if (!useDeepSearch) {
        const data = await api(`/api/search?q=${encodeURIComponent(value)}&mode=quick&types=paper,artifact,project&limit=50`);
        if (token !== requestToken.current) return;
        setResponse(data);
        setBusy(false);
        setStatusMessage?.("快速搜索完成");
        return;
      }

      const queued = await postJson("/api/search", {
        mode: "deep",
        query: value,
        types: ["paper", "artifact", "project"],
        limit: 50
      });
      if (token !== requestToken.current) return;
      setJob({ ...queued, requestToken: token });
      setStatusMessage?.("深度搜索已进入队列");
      await pollDeepJob(queued.worker_job_id, token);
    } catch (nextError) {
      if (token !== requestToken.current) return;
      setBusy(false);
      setError(nextError.message);
      setStatusMessage?.(nextError.message);
    }
  }

  async function submit(event) {
    event?.preventDefault();
    await runSearch(query.trim(), deepSearch);
  }

  async function retryWithDeepSearch() {
    const value = String(response?.query || query).trim();
    setDeepSearch(true);
    window.sessionStorage.setItem(MODE_KEY, "deep");
    await runSearch(value, true);
  }

  if (!isRendered) return null;

  const stats = response?.stats || {};
  const partialFailures = Array.isArray(stats.partial_failures) ? stats.partial_failures : [];
  const modeLabel = deepSearch ? "搜索模型已启用" : "数据库快速搜索";

  return (
    <div className={`global-search-backdrop ${isClosing ? "is-closing" : ""}`} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section aria-label="全局搜索" aria-modal="true" className="global-search-dialog" role="dialog">
        <header className="global-search-header">
          <div>
            <span>Research search</span>
            <h2>搜索研究空间</h2>
          </div>
          <button aria-label="关闭搜索" className="global-search-close" onClick={onClose} type="button">×</button>
        </header>

        <form className="global-search-form" onSubmit={submit}>
          <SearchIcon />
          <input
            aria-label="搜索论文、产物与项目"
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索论文、产物与项目…"
            ref={inputRef}
            value={query}
          />
          <button
            aria-label={deepSearch ? "关闭搜索模型" : "启用搜索模型"}
            aria-pressed={deepSearch}
            className={`global-search-brain ${deepSearch ? "active" : ""}`}
            disabled={busy}
            onClick={toggleDeepSearch}
            title={deepSearch ? "关闭搜索模型" : "启用搜索模型"}
            type="button"
          >
            <BrainIcon />
          </button>
          <button className="global-search-submit" disabled={busy} type="submit">
            {busy ? "搜索中" : "搜索"}
          </button>
        </form>

        <div className="global-search-mode-note">
          <span className={deepSearch ? "model-on" : ""}><i aria-hidden="true" />{modeLabel}</span>
          <kbd>Esc</kbd><small>关闭</small>
        </div>

        <div className="global-search-content">
          {busy ? (
            <section className="global-search-state" aria-live="polite">
              <i aria-hidden="true" />
              <div>
                <strong>{deepSearch ? "正在跨索引检索" : "正在查询数据库"}</strong>
                <span>{deepSearch ? `任务 ${job?.worker_job_id || "排队中"} · 由搜索模型理解语义` : "快速搜索不会调用模型"}</span>
              </div>
            </section>
          ) : null}

          {error ? <div className="global-search-error" role="alert">{error}</div> : null}
          {partialFailures.length ? (
            <div className="global-search-warning" role="status">
              部分来源不可用，已保留其他结果：{partialFailures.map((item) => item.source).join("、")}
            </div>
          ) : null}

          {response ? (
            <section className="global-search-results">
              <header>
                <div>
                  <span>{response.mode === "deep" ? "Semantic results" : "Database results"}</span>
                  <strong>{response.results?.length || 0} 条结果</strong>
                </div>
                <small>
                  {stats.query_embedding_model ? `模型 ${stats.query_embedding_model} · ` : ""}
                  {Number(stats.elapsed_ms || 0)} ms
                </small>
              </header>

              <nav className="global-search-types" aria-label="结果类型">
                {TYPE_OPTIONS.map(([value, label]) => (
                  <button className={activeType === value ? "active" : ""} key={value} onClick={() => setActiveType(value)} type="button">
                    {label}
                  </button>
                ))}
              </nav>

              <div className="global-search-list">
                {results.map((result) => (
                  <Link className="global-search-result" key={`${result.entity_type}-${result.entity_id}`} onClick={onClose} to={result.href}>
                    <span className={`global-result-kind kind-${result.entity_type}`}>{ENTITY_LABELS[result.entity_type] || result.entity_type}</span>
                    <div>
                      <small>{resultMeta(result)}</small>
                      <h3><Highlight query={response.query} text={result.title} /></h3>
                      <p><Highlight query={response.query} text={result.snippet} /></p>
                      <footer>
                        {(result.matched_by || []).map((item) => <span key={item}>{item}</span>)}
                        <b>打开详情 →</b>
                      </footer>
                    </div>
                  </Link>
                ))}
                {!results.length ? (
                  <div className="global-search-empty">
                    <strong>没有找到匹配结果</strong>
                    {response.mode === "deep" ? (
                      <span>请确认索引任务已完成，或换一个更具体的研究描述。</span>
                    ) : response.results?.length ? (
                      <span>当前结果中没有这一类型，可切换到“全部”查看。</span>
                    ) : (
                      <div className="global-search-deep-prompt">
                        <span>快速搜索没有找到“{response.query || query}”，是否使用深度搜索继续查找？</span>
                        <button disabled={busy} onClick={retryWithDeepSearch} type="button">
                          <BrainIcon />
                          使用深度搜索
                        </button>
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}

          {!busy && !error && !response ? (
            <div className="global-search-intro">
              <span className="global-search-intro-icon"><SearchIcon /></span>
              <strong>从整个研究空间开始查找</strong>
              <p>输入标题、作者、方法或研究问题；需要语义理解时，点击输入框右侧的 Brain 图标。</p>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
