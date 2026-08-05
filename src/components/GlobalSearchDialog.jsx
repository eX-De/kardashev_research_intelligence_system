import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { api } from "../lib/dashboard.js";
import "../styles/GlobalSearchDialog.css";

const MODE_KEY = "kris.unified-search.mode";
const TYPE_CODES = ["all", "paper", "conversation", "artifact", "project"];

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

function resultMeta(result, t) {
  const bits = [t(`search.entity.${result.entity_type}`, { defaultValue: result.entity_type })];
  const source = t(`search.source.${result.source_type}`, { defaultValue: result.source_type });
  if (source) bits.push(source);
  if (Number.isFinite(Number(result.score))) bits.push(t("search.relevance", { percent: Math.round(Number(result.score) * 100) }));
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
  const { t } = useTranslation("papers");
  const navigate = useNavigate();
  const [isRendered, setIsRendered] = useState(isOpen);
  const [isClosing, setIsClosing] = useState(false);
  const [query, setQuery] = useState("");
  const [deepSearch, setDeepSearch] = useState(initialDeepSearch);
  const [activeType, setActiveType] = useState("all");
  const [response, setResponse] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef(null);
  const abortController = useRef(null);
  const requestToken = useRef(0);
  const returnFocusTarget = useRef(null);

  const results = useMemo(() => {
    const items = response?.results || [];
    return activeType === "all" ? items : items.filter((item) => item.entity_type === activeType);
  }, [activeType, response]);

  useEffect(() => () => {
    requestToken.current += 1;
    abortController.current?.abort();
  }, []);

  useEffect(() => {
    if (isOpen) {
      setIsRendered(true);
      setIsClosing(false);
      return undefined;
    }
    if (!isRendered) return undefined;

    requestToken.current += 1;
    abortController.current?.abort();
    abortController.current = null;
    setBusy(false);

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
    if (!isOpen || !isRendered) return undefined;
    returnFocusTarget.current = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus({ preventScroll: true });
      const cursor = input.value.length;
      input.setSelectionRange?.(cursor, cursor);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      returnFocusTarget.current?.focus?.();
    };
  }, [isOpen, isRendered]);

  function toggleDeepSearch() {
    const nextValue = !deepSearch;
    setDeepSearch(nextValue);
    window.sessionStorage.setItem(MODE_KEY, nextValue ? "deep" : "quick");
  }

  async function runSearch(value, useDeepSearch) {
    if (!value) {
      setError(t("search.errors.empty"));
      inputRef.current?.focus();
      return;
    }

    const token = requestToken.current + 1;
    requestToken.current = token;
    abortController.current?.abort();
    abortController.current = new AbortController();
    setBusy(true);
    setError("");
    setResponse(null);
    setActiveType("all");

    try {
      if (!useDeepSearch) {
        const data = await api(`/api/search?q=${encodeURIComponent(value)}&mode=quick&types=paper,conversation,artifact,project&limit=50`);
        if (token !== requestToken.current) return;
        setResponse(data);
        setBusy(false);
        setStatusMessage?.(t("search.status.quickComplete"));
        return;
      }

      const data = await api("/api/search", {
        method: "POST",
        body: JSON.stringify({
          mode: "deep",
          query: value,
          types: ["paper", "conversation", "artifact", "project"],
          limit: 50
        }),
        signal: abortController.current.signal
      });
      if (token !== requestToken.current) return;
      setResponse(data);
      setBusy(false);
      setStatusMessage?.(t("search.status.deepComplete"));
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

  function openResult(event, href) {
    event.preventDefault();
    navigate(href);
    onClose();
  }

  if (!isRendered) return null;

  const stats = response?.stats || {};
  const partialFailures = Array.isArray(stats.partial_failures) ? stats.partial_failures : [];
  const modeLabel = deepSearch ? t("search.mode.deep") : t("search.mode.quick");

  return (
    <div className={`global-search-backdrop ${isClosing ? "is-closing" : ""}`} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section aria-label={t("search.aria.dialog")} aria-modal="true" className="global-search-dialog" role="dialog">
        <header className="global-search-header">
          <div>
            <span>{t("search.eyebrow")}</span>
            <h2>{t("search.title")}</h2>
          </div>
          <button aria-label={t("search.aria.close")} className="global-search-close" onClick={onClose} type="button">×</button>
        </header>

        <form className="global-search-form" onSubmit={submit}>
          <SearchIcon />
          <input
            aria-label={t("search.aria.input")}
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("search.placeholder")}
            ref={inputRef}
            value={query}
          />
          <button
            aria-label={deepSearch ? t("search.disableModel") : t("search.enableModel")}
            aria-pressed={deepSearch}
            className={`global-search-brain ${deepSearch ? "active" : ""}`}
            disabled={busy}
            onClick={toggleDeepSearch}
            title={deepSearch ? t("search.disableModel") : t("search.enableModel")}
            type="button"
          >
            <BrainIcon />
          </button>
          <button className="global-search-submit" disabled={busy} type="submit">
            {busy ? t("search.searching") : t("search.submit")}
          </button>
        </form>

        <div className="global-search-mode-note">
          <span className={deepSearch ? "model-on" : ""}><i aria-hidden="true" />{modeLabel}</span>
          <kbd>Esc</kbd><small>{t("search.close")}</small>
        </div>

        <div className="global-search-content">
          {busy ? (
            <section className="global-search-state" aria-live="polite">
              <i aria-hidden="true" />
              <div>
                <strong>{deepSearch ? t("search.progress.deepTitle") : t("search.progress.quickTitle")}</strong>
                <span>{deepSearch ? t("search.progress.deepDetail", { job: t("search.progress.queued") }) : t("search.progress.quickDetail")}</span>
              </div>
            </section>
          ) : null}

          {error ? <div className="global-search-error" role="alert">{error}</div> : null}
          {partialFailures.length ? (
            <div className="global-search-warning" role="status">
              {t("search.partialFailure", { sources: partialFailures.map((item) => item.source).join(t("common.listSeparator")) })}
            </div>
          ) : null}

          {response ? (
            <section className="global-search-results">
              <header>
                <div>
                  <span>{response.mode === "deep" ? t("search.results.semantic") : t("search.results.database")}</span>
                  <strong>{t("search.results.count", { count: response.results?.length || 0 })}</strong>
                </div>
                <small>
                  {stats.query_embedding_model ? t("search.results.model", { model: stats.query_embedding_model }) : ""}
                  {Number(stats.elapsed_ms || 0)} ms
                </small>
              </header>

              <nav className="global-search-types" aria-label={t("search.aria.resultTypes")}>
                {TYPE_CODES.map((value) => (
                  <button className={activeType === value ? "active" : ""} key={value} onClick={() => setActiveType(value)} type="button">
                    {t(`search.entity.${value}`)}
                  </button>
                ))}
              </nav>

              <div className="global-search-list">
                {results.map((result) => (
                  <Link
                    className="global-search-result"
                    key={`${result.entity_type}-${result.entity_id}`}
                    onClick={(event) => openResult(event, result.href)}
                    to={result.href}
                  >
                    <span className={`global-result-kind kind-${result.entity_type}`}>{t(`search.entity.${result.entity_type}`, { defaultValue: result.entity_type })}</span>
                    <div>
                      <small>{resultMeta(result, t)}</small>
                      <h3><Highlight query={response.query} text={result.title} /></h3>
                      <p><Highlight query={response.query} text={result.snippet} /></p>
                      <footer>
                        {(result.matched_by || []).map((item) => <span key={item}>{item}</span>)}
                        <b>{t("search.openDetail")} →</b>
                      </footer>
                    </div>
                  </Link>
                ))}
                {!results.length ? (
                  <div className="global-search-empty">
                    <strong>{t("search.empty.title")}</strong>
                    {response.mode === "deep" ? (
                      <span>{t("search.empty.deep")}</span>
                    ) : response.results?.length ? (
                      <span>{t("search.empty.type")}</span>
                    ) : (
                      <div className="global-search-deep-prompt">
                        <span>{t("search.empty.quick", { query: response.query || query })}</span>
                        <button disabled={busy} onClick={retryWithDeepSearch} type="button">
                          <BrainIcon />
                          {t("search.useDeep")}
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
              <strong>{t("search.intro.title")}</strong>
              <p>{t("search.intro.description")}</p>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
