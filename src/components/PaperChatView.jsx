import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";

import {
  api,
  createApiError,
  emitAuthRequired,
  fmtDate,
  isAuthRequiredError,
  postJson,
  readResponseJson
} from "../lib/dashboard.js";
import { cacheNamespace, useApiCacheClient, useCachedApi } from "../lib/apiCache.jsx";
import { InlineLoader } from "./Loading.jsx";
import { LazyMarkdownReport } from "./LazyMarkdownReport.jsx";
import { RefreshButton } from "./RefreshButton.jsx";
import { WorkspaceDialog } from "./WorkspaceDialog.jsx";
import { WorkspacePaneLoader } from "./WorkspacePaneLoader.jsx";
import { WorkspaceSelect } from "./WorkspaceSelect.jsx";
import "../styles/PaperChatView.css";

const FOLLOWUP_PANEL_WIDTH = 380;
const FOLLOWUP_PANEL_MAX_HEIGHT = 360;
const READER_BOTTOM_THRESHOLD = 80;
const SELECTED_TEXT_LIMIT = 2000;
const SELECTION_CONTEXT_CHARS = 3200;

function normalizePromptText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function chatModelList(settings = {}) {
  const providers = Array.isArray(settings.llm_providers) ? settings.llm_providers : [];
  const options = [];
  for (const provider of providers) {
    const providerId = String(provider.id || "").trim();
    if (!providerId) continue;
    const models = Array.isArray(provider.chat_models)
      ? provider.chat_models
      : String(provider.chat_models || "").split(",");
    for (const rawModel of models) {
      const model = String(rawModel || "").trim();
      if (!model) continue;
      options.push({
        provider_id: providerId,
        model,
        label: `${String(provider.name || providerId).trim()} / ${model}`,
        value: JSON.stringify([providerId, model])
      });
    }
  }
  const providerId = String(settings.reader_chat_provider_id || settings.llm_chat_provider_id || "").trim();
  const model = String(settings.reader_chat_model || settings.llm_chat_model || "").trim();
  if (providerId && model && !options.some((item) => item.provider_id === providerId && item.model === model)) {
    const provider = providers.find((item) => item.id === providerId);
    options.unshift({ provider_id: providerId, model, label: `${provider?.name || providerId} / ${model}`, value: JSON.stringify([providerId, model]) });
  }
  return options;
}

function currentChatModelValue(settings = {}) {
  const providerId = String(settings.reader_chat_provider_id || settings.llm_chat_provider_id || "").trim();
  const model = String(settings.reader_chat_model || settings.llm_chat_model || "").trim();
  return providerId && model ? JSON.stringify([providerId, model]) : "";
}

function parseChatModelValue(value) {
  try {
    const [providerId, model] = JSON.parse(value);
    return { providerId: String(providerId || "").trim(), model: String(model || "").trim() };
  } catch {
    return { providerId: "", model: "" };
  }
}

function parseSseEvent(rawEvent) {
  let event = "message";
  const data = [];
  for (const line of rawEvent.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  return data.length ? { event, data: JSON.parse(data.join("\n")) } : null;
}

async function readSseStream(response, handlers) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Streaming response is not available in this browser.");
  const decoder = new TextDecoder();
  let buffer = "";
  const dispatch = (raw) => {
    const parsed = parseSseEvent(raw);
    if (parsed?.event === "start") handlers.onStart?.(parsed.data);
    if (parsed?.event === "chunk") handlers.onChunk?.(parsed.data.text || "");
    if (parsed?.event === "done") handlers.onDone?.(parsed.data);
    if (parsed?.event === "error") throw new Error(parsed.data.error || "Chat stream failed");
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let match = buffer.match(/\r?\n\r?\n/);
    while (match) {
      dispatch(buffer.slice(0, match.index));
      buffer = buffer.slice(match.index + match[0].length);
      match = buffer.match(/\r?\n\r?\n/);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) dispatch(buffer);
}

async function readErrorResponse(response, path, fallbackMessage) {
  const data = await readResponseJson(response);
  const error = createApiError(response, data, fallbackMessage);
  if (isAuthRequiredError(error)) emitAuthRequired({ path, status: response.status, data });
  return error;
}

function messageKey(message, index) {
  return String(message.id || `${message.source || message.role}-${index}`);
}

function readerQuestionLabel(content, t) {
  return normalizePromptText(content) || t("reader.chat.emptyQuestion");
}

function ReaderQuestionNavigator({ activeQuestionKey, items, onJump }) {
  const { t } = useTranslation("papers");
  const [open, setOpen] = useState(false);
  const navigatorRef = useRef(null);
  const panelRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    panelRef.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
    function closeNavigator(event) {
      if (event.key === "Escape") {
        setOpen(false);
        navigatorRef.current?.querySelector(".reader-question-line")?.focus();
        return;
      }
      if (event.type === "pointerdown" && !navigatorRef.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener("keydown", closeNavigator);
    document.addEventListener("pointerdown", closeNavigator, true);
    return () => {
      document.removeEventListener("keydown", closeNavigator);
      document.removeEventListener("pointerdown", closeNavigator, true);
    };
  }, [open]);

  if (!items.length) return null;
  return createPortal((
    <nav
      aria-label={t("reader.chat.navigatorAria")}
      className={`reader-question-navigator ${open ? "is-open" : ""}`}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
      onFocus={() => setOpen(true)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      ref={navigatorRef}
    >
      <div className="reader-question-panel-shell"><div className="reader-question-panel" ref={panelRef}>{items.map((item) => <button aria-current={item.key === activeQuestionKey ? "true" : undefined} className={`reader-question-entry ${item.key === activeQuestionKey ? "active" : ""}`} key={`question-entry-${item.key}`} onClick={() => onJump(item.key)} title={item.label} type="button"><span>{item.label}</span></button>)}</div></div>
      <div aria-expanded={open} className="reader-question-rail">{items.map((item) => <button aria-current={item.key === activeQuestionKey ? "true" : undefined} aria-label={t("reader.chat.jumpTo", { label: item.label })} className={`reader-question-line ${item.key === activeQuestionKey ? "active" : ""}`} key={`question-line-${item.key}`} onClick={() => onJump(item.key)} title={item.label} type="button"><span aria-hidden="true" /></button>)}</div>
    </nav>
  ), document.body);
}

function sourceLabel(source, t) {
  if (source === "analysis_prompt") return t("reader.chat.sourcePrompt");
  if (source === "analysis_report") return t("common.fullReport");
  return source === "chat" ? "Chat" : source || "";
}

function ChatMessage({ deleting, message, navigationKey, onDelete }) {
  const { t, i18n } = useTranslation("papers");
  const assistant = message.role === "assistant";
  const numericId = Number(message.id);
  const persistedId = Number.isInteger(numericId) ? numericId : null;
  const analysisSeed = ["analysis_prompt", "analysis_report"].includes(message.source);
  const canDelete = persistedId && persistedId > 0 && message.source === "chat" && onDelete;
  const navigationAnchor = message.source === "analysis_report" || (!assistant && message.source === "chat");
  return (
    <article
      className={`reader-message ${assistant ? "assistant" : "user"} ${analysisSeed ? "analysis-seed" : ""} ${message.transient ? "transient" : ""}`}
      data-message-id={persistedId ?? undefined}
      data-reader-message={persistedId ? "true" : undefined}
      data-reader-question-key={navigationAnchor ? navigationKey : undefined}
    >
      <header className="reader-message-header">
        <div className="reader-message-identity">
          <i aria-hidden="true" className="reader-message-avatar">{assistant ? "AI" : t("reader.chat.you")}</i>
          <div><strong>{assistant ? t("reader.chatAssistant") : t("reader.chat.you")}</strong><span>{sourceLabel(message.source, t)}</span></div>
        </div>
        <div className="reader-message-badges">
          {message.model ? <span>{message.model}</span> : null}
          {message.created_at ? <span>{fmtDate(message.created_at, i18n.resolvedLanguage || i18n.language)}</span> : null}
          {message.streaming ? <span>{t("common.generating")}</span> : null}
          {message.context?.reference_paper_ids?.length ? <span>{t("reader.chat.referenceCount", { count: message.context.reference_paper_ids.length })}</span> : null}
          {canDelete ? <button className="reader-message-delete" disabled={deleting} onClick={() => onDelete(persistedId)} type="button">{deleting ? t("common.deleting") : t("common.delete")}</button> : null}
        </div>
      </header>
      <div className="reader-message-body" data-message-content="true">
        {assistant ? (message.content ? <LazyMarkdownReport markdown={message.content} /> : <p>…</p>) : <p>{message.content}</p>}
      </div>
    </article>
  );
}

function getSelectionRect(selection) {
  if (!selection || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  return rect.width || rect.height ? rect : range.getClientRects()[0] || null;
}

function getFollowUpPanelPosition(rect) {
  const width = Math.min(FOLLOWUP_PANEL_WIDTH, window.innerWidth - 24);
  const left = Math.min(Math.max(rect.left + rect.width / 2 - width / 2, 12), window.innerWidth - width - 12);
  let top = rect.bottom + 8;
  if (top + FOLLOWUP_PANEL_MAX_HEIGHT > window.innerHeight) top = Math.max(12, rect.top - FOLLOWUP_PANEL_MAX_HEIGHT - 8);
  return { left, top, width };
}

function selectionContext(selection, contentElement) {
  const selectedLength = Math.min(selection.getRangeAt(0).toString().length, SELECTION_CONTEXT_CHARS);
  const fullText = contentElement.textContent || "";
  const before = document.createRange();
  before.selectNodeContents(contentElement);
  before.setEnd(selection.getRangeAt(0).startContainer, selection.getRangeAt(0).startOffset);
  const startOffset = before.toString().length;
  before.detach?.();
  const margin = Math.floor(Math.max(SELECTION_CONTEXT_CHARS - selectedLength, 0) / 2);
  return normalizePromptText(fullText.slice(Math.max(0, startOffset - margin), startOffset + selectedLength + margin));
}

function ConversationList({ activePaperId, items, loading, onSelect, query, questionFilter, setQuery, setQuestionFilter, total }) {
  const { t, i18n } = useTranslation("papers");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visible = items.filter((item) => !normalizedQuery || `${item.title || ""} ${item.arxiv_id || ""} ${item.last_user_prompt || ""}`.toLocaleLowerCase().includes(normalizedQuery));
  const questionFilterOptions = ["all", "with", "without"].map((value) => [value, t(`reader.chat.questionFilter.${value}`)]);
  const selectedQuestionFilterLabel = t(`reader.chat.questionFilter.${questionFilter}`);
  const activeFilterCount = Number(questionFilter !== "all") + Number(Boolean(query.trim()));
  const visibleCount = query.trim() ? visible.length : total;
  const emptyState = query.trim()
    ? { description: t("reader.chat.emptyList.searchDescription"), title: t("reader.chat.emptyList.searchTitle") }
    : { description: t(`reader.chat.emptyList.${questionFilter}Description`), title: t(`reader.chat.emptyList.${questionFilter}Title`) };

  function clearFilters() {
    setQuery("");
    setQuestionFilter("all");
  }

  return (
    <section className="inbox-panel report-queue-list-panel chat-conversation-panel" aria-label={t("reader.chat.recentConversations", { defaultValue: "Recent conversations" })}>
      <header className="inbox-list-heading queue-list-header">
        <div><span>{t("reader.chat.eyebrow")}</span><h2>{t("reader.chat.recentConversations", { defaultValue: "Recent conversations" })}</h2></div>
        <div className="inbox-list-heading-actions"><em>{loading ? "…" : visibleCount}</em></div>
      </header>
      <div className="paper-filter-stack chat-filter-stack">
        <div className="paper-filter-summary">
          <div className="paper-active-filters">
            <span>{questionFilter === "all" && !query.trim() ? t("reader.chat.questionFilter.all") : selectedQuestionFilterLabel}</span>
            {query.trim() ? <span>{t("library.filters.searchValue", { query: query.trim() })}</span> : null}
          </div>
          <div className="paper-filter-summary-actions">
            {activeFilterCount ? <button className="filter-clear-button" onClick={clearFilters} type="button">{t("common.clearFilters")}</button> : null}
            <button
              aria-controls="chat-conversation-filter-panel"
              aria-expanded={filtersOpen}
              className="left-filter-toggle"
              onClick={() => setFiltersOpen((current) => !current)}
              type="button"
            >
              {filtersOpen ? t("common.collapseFilters") : t("common.filters", { count: activeFilterCount || "" })}
            </button>
          </div>
        </div>
        <div aria-hidden={!filtersOpen} className={`paper-filter-collapse ${filtersOpen ? "is-open" : ""}`} id="chat-conversation-filter-panel" inert={!filtersOpen}>
          <div className="library-toolbar paper-library-toolbar chat-conversation-toolbar" aria-label={t("reader.chat.questionFilter.aria")}>
            <div className="library-filter-control paper-filter-control">
              <span>{t("reader.chat.questionFilter.label")}</span>
              <WorkspaceSelect ariaLabel={t("reader.chat.questionFilter.aria")} onChange={setQuestionFilter} options={questionFilterOptions} value={questionFilter} />
            </div>
            <label className="library-filter-control paper-filter-control">
              <span>{t("common.search")}</span>
              <input onChange={(event) => setQuery(event.target.value)} placeholder={t("reader.chat.searchPlaceholder")} type="search" value={query} />
            </label>
          </div>
        </div>
      </div>
      <div className="paper-list inbox-paper-list report-queue-paper-list chat-conversation-list">
        {loading ? <WorkspacePaneLoader rows={6} title={t("common.loading")} variant="list" /> : visible.length ? visible.map((item) => (
          <article
            className={`inbox-paper-row report-queue-paper-row chat-conversation-row ${Number(item.paper_id) === Number(activePaperId) ? "active" : ""}`}
            key={item.paper_id}
            onClick={() => onSelect(item.paper_id)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              onSelect(item.paper_id);
            }}
            role="button"
            tabIndex={0}
          >
            <div className="inbox-paper-row-head"><span className="inbox-score">{item.arxiv_id || t("reader.localPaper")}</span><span className="chat-conversation-count">{t("reader.chat.questionCount", { count: item.question_count || 0 })}</span></div>
            <h2>{item.title || t("reader.untitledPaper")}</h2>
            <p className="chat-conversation-prompt">{item.last_user_prompt || t("reader.chat.reportOnly")}</p>
            <div className="inbox-paper-meta">{item.last_activity_at ? <span>{fmtDate(item.last_activity_at, i18n.resolvedLanguage || i18n.language)}</span> : null}</div>
          </article>
        )) : <div className="queue-empty-state chat-empty-list"><strong>{emptyState.title}</strong><p>{emptyState.description}</p></div>}
      </div>
    </section>
  );
}

function ChatWorkspace({
  busy,
  deletingMessageId,
  detail,
  displayedMessages,
  message,
  messageAnchorId,
  onChatModelChange,
  onDeleteMessage,
  onProjectContextChange,
  onReferencePapersSave,
  onSendMessage,
  onSendQuestion,
  projectContextEnabled,
  referenceCandidates,
  savingChatModel,
  savingReferencePapers,
  setMessage,
  settings
}) {
  const { t } = useTranslation("papers");
  const [referenceDialogOpen, setReferenceDialogOpen] = useState(false);
  const [referenceQuery, setReferenceQuery] = useState("");
  const [draftReferenceIds, setDraftReferenceIds] = useState([]);
  const [selectedText, setSelectedText] = useState("");
  const [selectionAnchor, setSelectionAnchor] = useState(null);
  const [followUpPosition, setFollowUpPosition] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [questionError, setQuestionError] = useState("");
  const [generatingQuestions, setGeneratingQuestions] = useState(false);
  const [messageScroll, setMessageScroll] = useState({ activeQuestionKey: null, atBottom: true, max: 0, top: 0 });
  const messagesRef = useRef(null);
  const chatInitializedRef = useRef(false);
  const latestTransientQuestionRef = useRef(null);
  const highlightedAnchorRef = useRef(null);
  const stickToBottomRef = useRef(true);
  const followupAbortRef = useRef(null);
  const paper = detail?.paper;
  const linkedProjects = detail?.linked_projects || [];
  const recommendations = (detail?.project_recommendations || []).filter((item) => ["pending", "accepted"].includes(item.state));
  const contextProjectNames = [...new Set([...linkedProjects, ...recommendations].map((item) => item.project_name).filter(Boolean))];
  const hasProjectContext = contextProjectNames.length > 0;
  const referencePapers = detail?.reference_papers || [];
  const candidateMap = new Map([
    ...referencePapers.map((item) => [Number(item.paper_id), item]),
    ...referenceCandidates.map((item) => [Number(item.paper_id ?? item.id), { ...item, paper_id: Number(item.paper_id ?? item.id) }])
  ]);
  const normalizedReferenceQuery = referenceQuery.trim().toLocaleLowerCase();
  const visibleReferenceCandidates = [...candidateMap.values()]
    .filter((item) => Number(item.paper_id) !== Number(paper?.id))
    .filter((item) => !normalizedReferenceQuery || `${item.title || ""} ${item.arxiv_id || ""}`.toLocaleLowerCase().includes(normalizedReferenceQuery));
  const chatModels = chatModelList(settings || {});
  const selectedModel = currentChatModelValue(settings || {});
  const modelOptions = chatModels.length ? [{ label: t("reader.chat.selectModel"), value: "" }, ...chatModels] : [["", t("reader.chat.noModel")]];
  const navigationItems = useMemo(() => {
    const hasUserQuestions = displayedMessages.some((item) => item.role === "user" && item.source === "chat");
    if (!hasUserQuestions) return [];
    return displayedMessages.flatMap((item, index) => {
      if (item.source === "analysis_report") {
        return [{ key: messageKey(item, index), label: t("reader.chat.paperReport"), transient: false }];
      }
      if (item.role !== "user" || item.source !== "chat") return [];
      return [{ key: messageKey(item, index), label: readerQuestionLabel(item.content, t), transient: Boolean(item.transient) }];
    });
  }, [displayedMessages, t]);
  const latestTransientQuestionKey = [...navigationItems].reverse().find((item) => item.transient)?.key || null;

  const updateMessageScroll = useCallback(() => {
    const container = messagesRef.current;
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    const questionElements = [...container.querySelectorAll("[data-reader-question-key]")];
    const viewportMarker = container.scrollTop + Math.min(container.clientHeight * 0.3, 180);
    let activeQuestionKey = questionElements[0]?.dataset.readerQuestionKey || null;
    for (const element of questionElements) {
      const elementTop = element.getBoundingClientRect().top - containerRect.top + container.scrollTop;
      if (elementTop > viewportMarker) break;
      activeQuestionKey = element.dataset.readerQuestionKey || activeQuestionKey;
    }
    const max = Math.max(0, container.scrollHeight - container.clientHeight);
    const top = Math.max(0, container.scrollTop);
    const atBottom = max - top <= READER_BOTTOM_THRESHOLD;
    stickToBottomRef.current = atBottom;
    setMessageScroll((current) => (
      current.activeQuestionKey === activeQuestionKey && current.atBottom === atBottom && current.max === max && current.top === top
        ? current
        : { activeQuestionKey, atBottom, max, top }
    ));
  }, []);

  const jumpToQuestion = useCallback((questionKey) => {
    const container = messagesRef.current;
    if (!container) return;
    const target = [...container.querySelectorAll("[data-reader-question-key]")].find((element) => element.dataset.readerQuestionKey === String(questionKey));
    if (!target) return;
    const containerRect = container.getBoundingClientRect();
    const targetTop = target.getBoundingClientRect().top - containerRect.top + container.scrollTop - 10;
    stickToBottomRef.current = false;
    container.scrollTo({ behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", top: Math.max(0, targetTop) });
  }, []);

  const jumpToBottom = useCallback((behavior = "smooth") => {
    const container = messagesRef.current;
    if (!container) return;
    stickToBottomRef.current = true;
    container.scrollTo({ behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : behavior, top: container.scrollHeight });
  }, []);

  const clearSelection = useCallback(() => {
    followupAbortRef.current?.abort();
    followupAbortRef.current = null;
    setGeneratingQuestions(false);
    setSelectedText("");
    setSelectionAnchor(null);
    setFollowUpPosition(null);
    setQuestions([]);
    setQuestionError("");
    window.getSelection?.().removeAllRanges?.();
  }, []);

  useEffect(() => {
    setGeneratingQuestions(false);
    return () => {
      followupAbortRef.current?.abort();
      followupAbortRef.current = null;
    };
  }, [paper?.id]);

  useEffect(() => {
    if (!paper?.id) return;
    const frame = requestAnimationFrame(() => {
      const container = messagesRef.current;
      if (!container) return;
      const anchorId = Number(messageAnchorId || 0);
      const target = anchorId ? container.querySelector(`[data-message-id="${anchorId}"]`) : null;
      if (target) {
        const key = `${paper.id}:${anchorId}`;
        if (highlightedAnchorRef.current !== key) {
          highlightedAnchorRef.current = key;
          chatInitializedRef.current = true;
          stickToBottomRef.current = false;
          target.scrollIntoView({ behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
          target.classList.add("message-anchor-highlight");
          window.setTimeout(() => target.classList.remove("message-anchor-highlight"), 2200);
        }
      }
      updateMessageScroll();
    });
    return () => cancelAnimationFrame(frame);
  }, [displayedMessages.length, messageAnchorId, paper?.id, updateMessageScroll]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const container = messagesRef.current;
      if (!container) return;
      if (!chatInitializedRef.current) {
        stickToBottomRef.current = true;
        container.scrollTop = container.scrollHeight;
        chatInitializedRef.current = true;
      }
      updateMessageScroll();
    });
    return () => cancelAnimationFrame(frame);
  }, [updateMessageScroll]);

  useEffect(() => {
    if (!latestTransientQuestionKey) return undefined;
    if (latestTransientQuestionRef.current === latestTransientQuestionKey) return undefined;
    latestTransientQuestionRef.current = latestTransientQuestionKey;
    const frame = requestAnimationFrame(() => jumpToBottom("auto"));
    return () => cancelAnimationFrame(frame);
  }, [jumpToBottom, latestTransientQuestionKey]);

  useLayoutEffect(() => {
    const container = messagesRef.current;
    if (!container || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || typeof IntersectionObserver === "undefined") return undefined;
    const observedMessages = new Set();
    const revealMidpoint = () => {
      const rect = container.getBoundingClientRect();
      return rect.top + rect.height / 2;
    };
    const isWithinRevealBounds = (element) => {
      const containerRect = container.getBoundingClientRect();
      const elementRect = element.getBoundingClientRect();
      const verticalInset = containerRect.height * 0.05;
      return elementRect.bottom > containerRect.top + verticalInset && elementRect.top < containerRect.bottom - verticalInset;
    };
    const setRevealDirection = (element, top = element.getBoundingClientRect().top) => {
      element.classList.remove("reveal-from-top", "reveal-from-bottom");
      element.classList.add(top < revealMidpoint() ? "reveal-from-top" : "reveal-from-bottom");
    };
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!observedMessages.has(entry.target) || !container.contains(entry.target)) return;
        if (entry.isIntersecting) setRevealDirection(entry.target, entry.boundingClientRect.top);
        entry.target.classList.toggle("is-scroll-visible", entry.isIntersecting);
      });
    }, { root: container, rootMargin: "-5% 0px -5% 0px", threshold: 0 });
    const currentMessages = () => [...container.children].filter((element) => element.classList.contains("reader-message"));
    const observeMessage = (element, index) => {
      element.style.setProperty("--reader-message-order", String(Math.min(index, 6)));
      if (observedMessages.has(element)) return;
      setRevealDirection(element);
      element.classList.toggle("is-scroll-visible", isWithinRevealBounds(element));
      element.classList.add("is-scroll-observed");
      observedMessages.add(element);
      observer.observe(element);
    };
    const syncObservedMessages = () => {
      const messages = currentMessages();
      const currentSet = new Set(messages);
      observedMessages.forEach((element) => {
        if (currentSet.has(element)) return;
        observer.unobserve(element);
        observedMessages.delete(element);
        element.classList.remove("is-scroll-observed", "is-scroll-visible", "reveal-from-top", "reveal-from-bottom");
      });
      messages.forEach(observeMessage);
    };
    syncObservedMessages();
    container.classList.add("is-reveal-ready");
    const mutationObserver = new MutationObserver(syncObservedMessages);
    mutationObserver.observe(container, { childList: true });
    return () => {
      mutationObserver.disconnect();
      observer.disconnect();
      container.classList.remove("is-reveal-ready");
      observedMessages.forEach((element) => element.classList.remove("is-scroll-observed", "is-scroll-visible", "reveal-from-top", "reveal-from-bottom"));
    };
  }, [paper?.id]);

  useEffect(() => {
    const container = messagesRef.current;
    if (!container || typeof ResizeObserver === "undefined") return undefined;
    const syncMessageViewport = () => {
      if (stickToBottomRef.current) container.scrollTop = container.scrollHeight;
      updateMessageScroll();
    };
    const frame = requestAnimationFrame(syncMessageViewport);
    const resizeObserver = new ResizeObserver(syncMessageViewport);
    const observedChildren = new Set();
    const syncObservedChildren = () => {
      const children = new Set(container.children);
      observedChildren.forEach((child) => {
        if (children.has(child)) return;
        resizeObserver.unobserve(child);
        observedChildren.delete(child);
      });
      children.forEach((child) => {
        if (observedChildren.has(child)) return;
        observedChildren.add(child);
        resizeObserver.observe(child);
      });
      syncMessageViewport();
    };
    resizeObserver.observe(container);
    syncObservedChildren();
    const mutationObserver = new MutationObserver(syncObservedChildren);
    mutationObserver.observe(container, { childList: true });
    return () => {
      cancelAnimationFrame(frame);
      mutationObserver.disconnect();
      resizeObserver.disconnect();
    };
  }, [paper?.id, updateMessageScroll]);

  useEffect(() => {
    if (!selectedText) return undefined;
    function selectionIsInMessages(selection) {
      const root = messagesRef.current;
      const anchorNode = selection?.anchorNode;
      const focusNode = selection?.focusNode;
      return Boolean(root && anchorNode && focusNode && root.contains(anchorNode) && root.contains(focusNode));
    }
    function closeIfCleared() {
      const selection = window.getSelection?.();
      if (!selection || !selection.rangeCount || !normalizePromptText(selection.toString()) || !selectionIsInMessages(selection)) clearSelection();
    }
    function refreshPanelPosition() {
      const selection = window.getSelection?.();
      if (!selection || !selection.rangeCount || !selectionIsInMessages(selection)) return;
      const rect = getSelectionRect(selection);
      if (rect) setFollowUpPosition(getFollowUpPanelPosition(rect));
    }
    document.addEventListener("selectionchange", closeIfCleared);
    window.addEventListener("resize", refreshPanelPosition);
    window.addEventListener("scroll", refreshPanelPosition, true);
    return () => {
      document.removeEventListener("selectionchange", closeIfCleared);
      window.removeEventListener("resize", refreshPanelPosition);
      window.removeEventListener("scroll", refreshPanelPosition, true);
    };
  }, [clearSelection, selectedText]);

  if (!paper) return <div className="empty-detail chat-empty-detail"><span>CHAT</span><h2>{t("reader.empty.title")}</h2><p>{t("reader.chat.startFromLibrary", { defaultValue: "Open a paper from the library to start a conversation." })}</p></div>;

  function updateSelection() {
    const root = messagesRef.current;
    const selection = window.getSelection?.();
    if (!root || !selection || !selection.rangeCount || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return;
    const anchorContent = (selection.anchorNode?.nodeType === 1 ? selection.anchorNode : selection.anchorNode?.parentElement)?.closest?.("[data-message-content='true']");
    const focusContent = (selection.focusNode?.nodeType === 1 ? selection.focusNode : selection.focusNode?.parentElement)?.closest?.("[data-message-content='true']");
    const messageId = Number(anchorContent?.closest("[data-message-id]")?.dataset?.messageId);
    const text = normalizePromptText(selection.toString());
    const rect = getSelectionRect(selection);
    if (!anchorContent || anchorContent !== focusContent || !Number.isInteger(messageId) || !text || !rect) return;
    setSelectedText(text.slice(0, SELECTED_TEXT_LIMIT));
    setSelectionAnchor({ messageId, contextText: selectionContext(selection, anchorContent) });
    setFollowUpPosition(getFollowUpPanelPosition(rect));
    setQuestions([]);
    setQuestionError("");
  }

  async function generateQuestions() {
    if (!selectedText || !selectionAnchor?.messageId) return;
    setGeneratingQuestions(true);
    setQuestionError("");
    followupAbortRef.current?.abort();
    const controller = new AbortController();
    followupAbortRef.current = controller;
    try {
      const data = await api(`/api/reader/papers/${paper.id}/follow-up-questions`, {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({
          selected_text: selectedText,
          anchor_message_id: selectionAnchor.messageId,
          context_text: selectionAnchor.contextText
        })
      });
      setQuestions(data.questions || []);
    } catch (error) {
      if (!controller.signal.aborted) setQuestionError(error.message);
    } finally {
      if (followupAbortRef.current === controller) {
        followupAbortRef.current = null;
        setGeneratingQuestions(false);
      }
    }
  }

  function openReferences() {
    setDraftReferenceIds(referencePapers.map((item) => Number(item.paper_id)));
    setReferenceQuery("");
    setReferenceDialogOpen(true);
  }

  async function saveReferences() {
    if (await onReferencePapersSave(paper.id, draftReferenceIds)) setReferenceDialogOpen(false);
  }

  function handleComposerKeyDown(event) {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.nativeEvent?.isComposing || event.nativeEvent?.keyCode === 229) return;
    event.preventDefault();
    if (!busy && message.trim()) event.currentTarget.form?.requestSubmit();
  }

  return (
    <div className="detail-card inbox-detail-card reader-detail-card reader-detail-transition">
      <div className="detail-main">
        <div className="detail-title inbox-detail-title reader-detail-title">
          <span className="inbox-detail-eyebrow">{t("reader.detail.eyebrow", { id: paper.arxiv_id || t("reader.localPaper") })}</span>
          <h2>{paper.title || t("reader.untitledPaper")}</h2>
          <p className="inbox-detail-authors">{(paper.authors || []).slice(0, 8).join(", ") || t("common.noAuthors")}</p>
          <div className="inbox-detail-meta">
            <span>{(paper.categories || []).join(" · ") || "arXiv"}</span>
            <span>{t("reader.fullTextStatus", { status: paper.text_status || "pending" })}</span>
          </div>
          <div className="paper-detail-actions">
            <Link className="paper-detail-action" to={`/papers/library/${paper.id}`}>
              <span>{t("library.title")}</span><i aria-hidden="true">→</i>
            </Link>
            {paper.link ? (
              <a className="paper-detail-action" href={paper.link} target="_blank" rel="noreferrer" title={paper.link}>
                <span>{t("reader.actions.openSource")}</span><i aria-hidden="true">↗</i>
              </a>
            ) : null}
            {paper.pdf_path ? (
              <a className="paper-detail-action" href={`/api/reader/papers/${paper.id}/pdf`} target="_blank" rel="noreferrer">
                <span>{t("reader.actions.openPdf")}</span><i aria-hidden="true">↗</i>
              </a>
            ) : null}
          </div>
        </div>

        <section className="reader-chat inbox-content-section">
          <header className="inbox-section-heading reader-chat-heading">
            <div><span>{t("reader.chat.eyebrow")}</span><h3>{t("reader.chat.title")}</h3></div>
            <em>{t("reader.chat.messageCount", { count: displayedMessages.length })}</em>
          </header>
          <ReaderQuestionNavigator activeQuestionKey={messageScroll.activeQuestionKey} items={navigationItems} onJump={jumpToQuestion} />
          <div className="reader-messages-shell">
            <div className="reader-messages" onKeyUp={updateSelection} onMouseUp={updateSelection} onScroll={updateMessageScroll} ref={messagesRef}>
              {displayedMessages.length ? displayedMessages.map((item, index) => <ChatMessage deleting={deletingMessageId === Number(item.id)} key={messageKey(item, index)} message={item} navigationKey={messageKey(item, index)} onDelete={onDeleteMessage} />) : <p className="muted chat-empty-history">{t("reader.chat.empty")}</p>}
            </div>
            <input aria-label={t("reader.chat.scrollAria")} className={`reader-message-scrollbar ${messageScroll.max > 0 ? "is-visible" : ""}`} max={Math.max(1, messageScroll.max)} min="0" onChange={(event) => { if (!messagesRef.current) return; messagesRef.current.scrollTop = Number(event.target.value); updateMessageScroll(); }} step="1" type="range" value={Math.min(messageScroll.top, Math.max(1, messageScroll.max))} />
            {!messageScroll.atBottom && messageScroll.max > 0 ? <button aria-label={t("reader.chat.jumpBottom")} className="reader-scroll-to-bottom" onClick={() => jumpToBottom()} title={t("reader.chat.jumpLatest")} type="button"><svg aria-hidden="true" fill="none" viewBox="0 0 24 24"><path d="m6.5 9 5.5 5.5L17.5 9" /></svg></button> : null}
          </div>
          <div className="reader-chat-composer">
            <div className="reader-chat-toolbar">
              <div className="reader-chat-model-control"><span>{t("reader.chat.model")}</span><WorkspaceSelect ariaLabel={t("reader.chat.selectModel")} className="reader-chat-model-select" disabled={!settings || !chatModels.length || savingChatModel || busy} onChange={onChatModelChange} options={modelOptions} value={chatModels.some((item) => item.value === selectedModel) ? selectedModel : ""} /></div>
              <label className={`reader-project-context-control ${hasProjectContext ? "" : "is-disabled"}`} title={hasProjectContext ? t("reader.chat.projectContextTitle", { projects: contextProjectNames.join(t("common.listSeparator")) }) : t("reader.chat.noProjectContextTitle")}>
                <input checked={hasProjectContext && projectContextEnabled} disabled={!hasProjectContext || busy} onChange={(event) => onProjectContextChange(event.target.checked)} type="checkbox" /><i aria-hidden="true" className="reader-context-checkmark">✓</i><span>{t("reader.chat.useProjectContext")}<small>{hasProjectContext ? t("reader.projectCount", { count: contextProjectNames.length }) : t("reader.chat.noProjects")}</small></span>
              </label>
              <button className="reader-reference-button" onClick={openReferences} type="button">{t("reader.chat.addReferences")}</button>
            </div>
            {referencePapers.length ? <div className="reader-reference-tags"><span>{t("reader.chat.references")}</span>{referencePapers.map((reference) => <button disabled={savingReferencePapers || busy} key={reference.paper_id} onClick={() => onReferencePapersSave(paper.id, referencePapers.filter((item) => Number(item.paper_id) !== Number(reference.paper_id)).map((item) => Number(item.paper_id)))} title={t("reader.chat.removeReference")} type="button"><span>{reference.title || reference.arxiv_id}</span><strong aria-hidden="true" className="reader-reference-remove">×</strong></button>)}</div> : null}
            <form className="reader-composer" onSubmit={onSendMessage}><textarea disabled={busy} onChange={(event) => setMessage(event.target.value)} onKeyDown={handleComposerKeyDown} placeholder={t("reader.chat.placeholder")} value={message} /><button className={busy ? "is-busy" : undefined} disabled={busy || !message.trim()} type="submit">{busy ? <InlineLoader compact label={t("common.sending")} /> : t("common.send")}</button></form>
          </div>
        </section>
      </div>
      {selectedText && followUpPosition ? createPortal((
        <div className="reader-followups reader-followups-floating vision-reader-followups" onMouseDown={(event) => event.preventDefault()} style={{ left: followUpPosition.left, top: followUpPosition.top, width: followUpPosition.width }}>
          <div className="reader-followups-header"><strong>{t("reader.chat.followups")}</strong><button onClick={clearSelection} type="button">{t("common.clear")}</button></div>
          <p className="reader-followups-selection">{selectedText.length > 260 ? `${selectedText.slice(0, 260)}…` : selectedText}</p>
          <div className="reader-followups-actions"><button disabled={generatingQuestions || busy} onClick={generateQuestions} type="button">{generatingQuestions ? <InlineLoader compact label={t("common.generating")} /> : t("reader.chat.generateFollowups")}</button></div>
          {questionError ? <div className="error-line">{questionError}</div> : null}
          {questions.length ? <div className="reader-question-list">{questions.map((question) => <button disabled={busy} key={question} onClick={() => { clearSelection(); onSendQuestion(question); }} type="button">{question}</button>)}</div> : null}
        </div>
      ), document.body) : null}
      <WorkspaceDialog
        className="reference-picker-dialog"
        description={t("reader.reference.description")}
        eyebrow={t("reader.referenceEyebrow")}
        footer={<><span>{t("reader.reference.selected", { count: draftReferenceIds.length, max: 3 })}</span><div><button disabled={savingReferencePapers} onClick={() => setReferenceDialogOpen(false)} type="button">{t("common.cancel")}</button><button className="workspace-dialog-primary" disabled={savingReferencePapers} onClick={saveReferences} type="button">{savingReferencePapers ? t("common.saving") : t("reader.reference.apply")}</button></div></>}
        icon="RF"
        onClose={() => { if (!savingReferencePapers) setReferenceDialogOpen(false); }}
        open={referenceDialogOpen}
        title={t("reader.chat.addReferences")}
      >
        <div className="reader-reference-body workspace-reference-body">
          <label className="workspace-reference-search"><input autoFocus onChange={(event) => setReferenceQuery(event.target.value)} placeholder={t("reader.reference.searchPlaceholder")} type="search" value={referenceQuery} /><span>{t("reader.paperCount", { count: visibleReferenceCandidates.length })}</span></label>
          <div className="reader-reference-list">{visibleReferenceCandidates.length ? visibleReferenceCandidates.map((candidate) => {
            const id = Number(candidate.paper_id);
            const selected = draftReferenceIds.includes(id);
            const available = candidate.text_status === "complete";
            return <label className={`${selected ? "selected" : ""} ${!available ? "is-disabled" : ""}`} key={id}><input checked={selected} disabled={!available || (!selected && draftReferenceIds.length >= 3)} onChange={() => setDraftReferenceIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])} type="checkbox" /><i aria-hidden="true" className="reader-reference-checkmark">✓</i><span><strong>{candidate.title || t("reader.untitledPaper")}</strong><small>{candidate.arxiv_id || t("reader.paperFallback", { id })} · {available ? t("reader.reference.available") : t("reader.reference.unavailable")}</small></span></label>;
          }) : <p className="workspace-dialog-empty">{t("reader.reference.empty")}</p>}</div>
        </div>
      </WorkspaceDialog>
    </div>
  );
}

export function PaperChatView({ onSelectPaper, setStatusMessage = () => {}, targetPaperId, targetPaperKey }) {
  const { t } = useTranslation("papers");
  const cache = useApiCacheClient();
  const [searchParams] = useSearchParams();
  const [activePaperId, setActivePaperId] = useState(() => Number(targetPaperId || 0) || null);
  const [query, setQuery] = useState("");
  const [questionFilter, setQuestionFilter] = useState("all");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingUser, setPendingUser] = useState(null);
  const [streamingAssistant, setStreamingAssistant] = useState(null);
  const [deletingMessageId, setDeletingMessageId] = useState(null);
  const [savingChatModel, setSavingChatModel] = useState(false);
  const [savingReferencePapers, setSavingReferencePapers] = useState(false);
  const [projectContextPreferences, setProjectContextPreferences] = useState({});
  const chatAbortRef = useRef(null);
  const conversationsQuery = useCachedApi(
    ["reader", "conversations", questionFilter],
    () => api(`/api/reader/conversations?limit=100&offset=0&questions=${encodeURIComponent(questionFilter)}`),
    { staleTime: 30000 }
  );
  const settingsQuery = useCachedApi(["settings"], () => api("/api/settings"), { staleTime: Infinity });
  const referenceCandidatesQuery = useCachedApi(["reader", "papers", "reference-candidates"], () => api("/api/reader/papers?limit=300&offset=0"), { staleTime: 60000 });
  const detailQuery = useCachedApi(["reader", "paper", String(activePaperId || "")], () => api(`/api/reader/papers/${activePaperId}`), { enabled: Boolean(activePaperId), staleTime: 60000 });
  const items = conversationsQuery.data?.items || [];
  const detail = activePaperId ? detailQuery.data || null : null;
  const detailPaperId = Number(detail?.paper?.id || 0);
  // The shared detail API prepends the report prompt and generated report so
  // Chat preserves the original Reader conversation sequence.
  const baseMessages = detail?.reader_messages || [];
  const displayedMessages = useMemo(() => {
    const next = [...baseMessages];
    if (pendingUser && Number(pendingUser.paper_id) === detailPaperId && !baseMessages.some((item) => item.role === "user" && item.source === "chat" && item.content === pendingUser.content)) next.push(pendingUser);
    if (streamingAssistant && Number(streamingAssistant.paper_id) === detailPaperId) next.push(streamingAssistant);
    return next;
  }, [baseMessages, detailPaperId, pendingUser, streamingAssistant]);
  const hasProjectContext = Boolean(detail?.linked_projects?.length || detail?.project_recommendations?.some((item) => ["pending", "accepted"].includes(item.state)));
  const projectContextEnabled = hasProjectContext && projectContextPreferences[detailPaperId] !== false;
  const anchorMessageId = Number(searchParams.get("message") || 0) || null;

  const selectPaper = useCallback((paperId, options = {}) => {
    const id = Number(paperId);
    if (!id) return;
    setActivePaperId(id);
    onSelectPaper?.(id, options);
  }, [onSelectPaper]);

  useEffect(() => {
    const id = Number(targetPaperId || 0);
    if (id) setActivePaperId(id);
  }, [targetPaperId, targetPaperKey]);

  useEffect(() => {
    setPendingUser(null);
    setStreamingAssistant(null);
    setBusy(false);
    return () => {
      chatAbortRef.current?.abort();
      chatAbortRef.current = null;
    };
  }, [activePaperId]);

  useEffect(() => {
    if (targetPaperId || activePaperId || !conversationsQuery.hasData || !items.length) return;
    selectPaper(items[0].paper_id, { replace: true });
  }, [activePaperId, conversationsQuery.hasData, items, selectPaper, targetPaperId]);

  useEffect(() => {
    const error = conversationsQuery.error || detailQuery.error || settingsQuery.error || referenceCandidatesQuery.error;
    if (error) setStatusMessage(error.message);
  }, [conversationsQuery.error, detailQuery.error, referenceCandidatesQuery.error, setStatusMessage, settingsQuery.error]);

  async function refresh() {
    await Promise.all([conversationsQuery.refresh({ force: true }), activePaperId ? detailQuery.refresh({ force: true }) : Promise.resolve()]);
  }

  async function sendReaderMessage(rawMessage, options = {}) {
    const paperId = Number(activePaperId || 0);
    const nextMessage = String(rawMessage || "").trim();
    if (!paperId || !nextMessage) return;
    const sentAt = Date.now();
    chatAbortRef.current?.abort();
    const controller = new AbortController();
    chatAbortRef.current = controller;
    setBusy(true);
    setPendingUser({ id: `pending-user-${sentAt}`, paper_id: paperId, role: "user", content: nextMessage, source: "chat", created_at: new Date(sentAt).toISOString(), transient: true });
    setStreamingAssistant({ id: `streaming-assistant-${sentAt}`, paper_id: paperId, role: "assistant", content: "", source: "chat", created_at: new Date().toISOString(), transient: true, streaming: true });
    try {
      const path = `/api/reader/papers/${paperId}/chat`;
      const response = await fetch(path, { method: "POST", credentials: "same-origin", headers: { accept: "text/event-stream", "content-type": "application/json" }, body: JSON.stringify({ message: nextMessage, stream: true, include_project_context: projectContextEnabled }), signal: controller.signal });
      if (!response.ok) throw await readErrorResponse(response, path, t("reader.chatRequestFailed"));
      let completed = false;
      await readSseStream(response, {
        onStart(data) { setStreamingAssistant((current) => current && Number(current.paper_id) === paperId ? { ...current, model: data.model?.model || current.model, model_provider_id: data.model?.provider_id || current.model_provider_id } : current); },
        onChunk(text) { setStreamingAssistant((current) => current && Number(current.paper_id) === paperId ? { ...current, content: `${current.content}${text}` } : current); },
        onDone(data) { completed = true; if (data.detail) cache.setCache(["reader", "paper", String(paperId)], data.detail); }
      });
      if (!completed) await detailQuery.refresh({ force: true });
      cache.markStale(["reader", "conversations"]);
      conversationsQuery.refresh({ force: true }).catch(() => {});
      setStatusMessage(t("reader.messages.replyGenerated"));
    } catch (error) {
      if (!controller.signal.aborted && options.restoreOnFailure !== false) setMessage(nextMessage);
      if (!controller.signal.aborted) setStatusMessage(error.message);
      await detailQuery.refresh({ force: true }).catch(() => {});
    } finally {
      setPendingUser((current) => current && Number(current.paper_id) === paperId ? null : current);
      setStreamingAssistant((current) => current && Number(current.paper_id) === paperId ? null : current);
      if (chatAbortRef.current === controller) {
        chatAbortRef.current = null;
        setBusy(false);
      }
    }
  }

  async function sendMessage(event) {
    event.preventDefault();
    const nextMessage = message.trim();
    setMessage("");
    await sendReaderMessage(nextMessage);
  }

  async function deleteMessage(messageId) {
    if (!activePaperId) return;
    setDeletingMessageId(messageId);
    try {
      const data = await api(`/api/reader/papers/${activePaperId}/messages/${messageId}`, { method: "DELETE" });
      cache.setCache(["reader", "paper", String(activePaperId)], data);
      cache.markStale(["reader", "conversations"]);
      conversationsQuery.refresh({ force: true }).catch(() => {});
      setStatusMessage(t("reader.messages.messageDeleted"));
    } catch (error) {
      setStatusMessage(error.message);
    } finally {
      setDeletingMessageId(null);
    }
  }

  async function changeChatModel(value) {
    const { providerId, model } = parseChatModelValue(value);
    if (!providerId || !model) return;
    setSavingChatModel(true);
    try {
      const data = await postJson("/api/settings", { reader_chat_provider_id: providerId, reader_chat_model: model });
      cache.setCache(["settings"], data);
      setStatusMessage(t("reader.messages.modelChanged", { model }));
    } catch (error) {
      setStatusMessage(error.message);
    } finally {
      setSavingChatModel(false);
    }
  }

  async function saveReferencePapers(paperId, paperIds) {
    setSavingReferencePapers(true);
    try {
      const data = await api(`/api/reader/papers/${paperId}/reference-papers`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ paper_ids: paperIds }) });
      cache.setCache(["reader", "paper", String(paperId)], data);
      setStatusMessage(t("reader.messages.referencesUpdated"));
      return true;
    } catch (error) {
      setStatusMessage(error.message);
      return false;
    } finally {
      setSavingReferencePapers(false);
    }
  }

  return (
    <section className="view paper-chat-view reader-view vision-inbox">
      <header className="vision-topbar reader-queue-header chat-topbar">
        <div className="vision-brand"><span>{t("common.workspace")}</span><h1>{t("reader.chat.eyebrow")}</h1></div>
        <div className="vision-top-actions reader-queue-actions"><RefreshButton className="vision-refresh" onClick={() => refresh().catch((error) => setStatusMessage(error.message))} /></div>
      </header>
      <div className="reader-workspace inbox-workspace-grid">
        <ConversationList activePaperId={activePaperId} items={items} loading={!conversationsQuery.hasData} onSelect={selectPaper} query={query} questionFilter={questionFilter} setQuery={setQuery} setQuestionFilter={setQuestionFilter} total={Number(conversationsQuery.data?.total || 0)} />
        <main className="detail-panel inbox-detail-panel reader-detail-panel">{activePaperId && !detailQuery.hasData ? <WorkspacePaneLoader description={t("reader.detail.loadingSelected")} title={t("reader.detail.opening")} variant="report" /> : <ChatWorkspace busy={busy} deletingMessageId={deletingMessageId} detail={detail} displayedMessages={displayedMessages} key={detail?.paper?.id || "empty"} message={message} messageAnchorId={anchorMessageId} onChatModelChange={changeChatModel} onDeleteMessage={deleteMessage} onProjectContextChange={(enabled) => setProjectContextPreferences((current) => ({ ...current, [detailPaperId]: enabled }))} onReferencePapersSave={saveReferencePapers} onSendMessage={sendMessage} onSendQuestion={(question) => sendReaderMessage(question, { restoreOnFailure: false })} projectContextEnabled={projectContextEnabled} referenceCandidates={referenceCandidatesQuery.data?.items || []} savingChatModel={savingChatModel} savingReferencePapers={savingReferencePapers} setMessage={setMessage} settings={settingsQuery.data?.settings || null} />}</main>
      </div>
    </section>
  );
}
