import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
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
import { friendlyObsidianMessage, postObsidianJson, useObsidianCapability } from "../lib/obsidianCapability.js";
import { resolveReaderQueueSelection } from "../lib/paperSelection.js";
import { isRecentManualPaperImport, paperSourceFilterLabel, paperSourceFilterOptions } from "../lib/paperSource.js";
import { LazyMarkdownReport } from "./LazyMarkdownReport.jsx";
import { RefreshButton } from "./RefreshButton.jsx";
import { InlineLoader } from "./Loading.jsx";
import { WorkspaceDialog } from "./WorkspaceDialog.jsx";
import { WorkspacePaneLoader } from "./WorkspacePaneLoader.jsx";
import { WorkspacePagination } from "./WorkspacePagination.jsx";
import { WorkspaceSelect } from "./WorkspaceSelect.jsx";
import "../styles/ReaderView.css";

const REPORT_FILTER_CODES = ["all", "queued", "processing", "done", "failed", "cancelled"];

const READER_BOTTOM_THRESHOLD = 80;

function reportStatusLabel(status, t) {
  return t(`reportStatus.${status || "missing"}`, { defaultValue: status || t("reportStatus.missing") });
}

function useDebouncedValue(value, delay = 700, onCommit) {
  const [debounced, setDebounced] = useState(value);
  const debouncedRef = useRef(value);
  const onCommitRef = useRef(onCommit);
  useEffect(() => {
    onCommitRef.current = onCommit;
  }, [onCommit]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (Object.is(debouncedRef.current, value)) return;
      debouncedRef.current = value;
      onCommitRef.current?.(value);
      setDebounced(value);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [delay, value]);
  return debounced;
}

function parseSseEvent(rawEvent) {
  const lines = rawEvent.split(/\r?\n/);
  const dataLines = [];
  let event = "message";
  for (const line of lines) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (!dataLines.length) return null;
  return { event, data: JSON.parse(dataLines.join("\n")) };
}

async function readErrorResponse(response, path, fallbackMessage) {
  const data = await readResponseJson(response);
  const error = createApiError(response, data, fallbackMessage);
  if (isAuthRequiredError(error)) emitAuthRequired({ path, status: response.status, data });
  return error;
}

async function readSseStream(response, handlers) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Streaming response is not available in this browser.");
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let match = buffer.match(/\r?\n\r?\n/);
    while (match) {
      const rawEvent = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const parsed = parseSseEvent(rawEvent);
      if (parsed?.event === "start") handlers.onStart?.(parsed.data);
      if (parsed?.event === "chunk") handlers.onChunk?.(parsed.data.text || "");
      if (parsed?.event === "done") handlers.onDone?.(parsed.data);
      if (parsed?.event === "error") throw new Error(parsed.data.error || "Chat stream failed");
      match = buffer.match(/\r?\n\r?\n/);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    const parsed = parseSseEvent(buffer);
    if (parsed?.event === "chunk") handlers.onChunk?.(parsed.data.text || "");
    if (parsed?.event === "done") handlers.onDone?.(parsed.data);
    if (parsed?.event === "error") throw new Error(parsed.data.error || "Chat stream failed");
  }
}

function hasPersistedPendingUser(messages, pendingUser) {
  if (!pendingUser) return false;
  return messages.some((item) => item.role === "user" && item.content === pendingUser.content);
}

const FOLLOWUP_PANEL_WIDTH = 380;
const FOLLOWUP_PANEL_MAX_HEIGHT = 360;
const SELECTED_TEXT_LIMIT = 2000;
const SELECTION_CONTEXT_CHARS = 3200;

function chatModelList(settings = {}) {
  const providers = Array.isArray(settings.llm_providers) ? settings.llm_providers : [];
  const options = [];
  for (const provider of providers) {
    const providerId = String(provider.id || "").trim();
    if (!providerId) continue;
    const providerName = String(provider.name || providerId).trim();
    const models = Array.isArray(provider.chat_models)
      ? provider.chat_models
      : String(provider.chat_models || "").split(",");
    for (const rawModel of models) {
      const model = String(rawModel || "").trim();
      if (!model) continue;
      options.push({
        provider_id: providerId,
        model,
        label: `${providerName} / ${model}`,
        value: JSON.stringify([providerId, model])
      });
    }
  }

  const currentProviderId = String(settings.reader_chat_provider_id || settings.llm_chat_provider_id || "").trim();
  const currentModel = String(settings.reader_chat_model || settings.llm_chat_model || "").trim();
  if (
    currentProviderId &&
    currentModel &&
    !options.some((option) => option.provider_id === currentProviderId && option.model === currentModel)
  ) {
    const provider = providers.find((item) => item.id === currentProviderId);
    options.unshift({
      provider_id: currentProviderId,
      model: currentModel,
      label: `${provider?.name || currentProviderId} / ${currentModel}`,
      value: JSON.stringify([currentProviderId, currentModel])
    });
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
    return {
      providerId: String(providerId || "").trim(),
      model: String(model || "").trim()
    };
  } catch {
    return { providerId: "", model: "" };
  }
}

function normalizePromptText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function getSelectionRect(selection) {
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  if (rect.width || rect.height) return rect;
  return range.getClientRects()[0] || null;
}

function getFollowUpPanelPosition(rect) {
  const margin = 12;
  const width = Math.min(FOLLOWUP_PANEL_WIDTH, window.innerWidth - margin * 2);
  const left = Math.min(Math.max(rect.left + rect.width / 2 - width / 2, margin), window.innerWidth - width - margin);
  let top = rect.bottom + 8;
  if (top + FOLLOWUP_PANEL_MAX_HEIGHT > window.innerHeight) {
    top = Math.max(margin, rect.top - FOLLOWUP_PANEL_MAX_HEIGHT - 8);
  }
  return { left, top, width };
}

function getClosestMessageContent(node, root) {
  const element = node?.nodeType === 1 ? node : node?.parentElement;
  const content = element?.closest?.("[data-message-content='true']");
  return content && root.contains(content) ? content : null;
}

function getRangeText(element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  const text = range.toString();
  range.detach?.();
  return text;
}

function getSelectionStartOffset(selection, contentElement) {
  const range = selection.getRangeAt(0);
  const beforeSelection = document.createRange();
  beforeSelection.selectNodeContents(contentElement);
  beforeSelection.setEnd(range.startContainer, range.startOffset);
  const offset = beforeSelection.toString().length;
  beforeSelection.detach?.();
  return offset;
}

function getSelectionContextText(selection, contentElement) {
  const selectedLength = Math.min(selection.getRangeAt(0).toString().length, SELECTION_CONTEXT_CHARS);
  const fullText = getRangeText(contentElement);
  const startOffset = getSelectionStartOffset(selection, contentElement);
  const endOffset = startOffset + selectedLength;
  const beforeBudget = Math.floor(Math.max(SELECTION_CONTEXT_CHARS - selectedLength, 0) / 2);
  let contextStart = Math.max(0, startOffset - beforeBudget);
  let contextEnd = Math.min(fullText.length, contextStart + SELECTION_CONTEXT_CHARS);
  contextStart = Math.max(0, Math.min(contextStart, contextEnd - SELECTION_CONTEXT_CHARS));
  if (contextEnd < endOffset) {
    contextEnd = Math.min(fullText.length, endOffset);
    contextStart = Math.max(0, contextEnd - SELECTION_CONTEXT_CHARS);
  }
  return normalizePromptText(fullText.slice(contextStart, contextEnd));
}

function ReaderRow({ active, deleting, item, onDelete, onSelect, recentImport }) {
  const { t, i18n } = useTranslation("papers");
  const canDelete = item.status !== "processing";
  const linkedProjectNames = item.linked_project_names || [];
  const recommendationProjectNames = item.recommendation_project_names || [];
  const projectNames = linkedProjectNames.length ? linkedProjectNames : recommendationProjectNames;
  const projectCount = linkedProjectNames.length ? item.linked_project_count : item.recommendation_project_count;
  function selectRow() {
    onSelect(item.paper_id);
  }
  return (
    <article
      className={`inbox-paper-row report-queue-paper-row ${active ? "active" : ""} ${recentImport ? "recent-import" : ""}`}
      onClick={selectRow}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        selectRow();
      }}
      role="button"
      tabIndex={0}
    >
      <div className="inbox-paper-row-head">
        <span className="inbox-score">{item.arxiv_id || t("reader.localPaper")}</span>
        <div className="inbox-paper-row-actions">
          {recentImport ? <span className="reader-recent-import-badge" title={t("reader.recentImportTitle")}><i aria-hidden="true" />{t("reader.recentImport")}</span> : null}
          <span className={`inbox-report-status ${item.status || "missing"}`}>{reportStatusLabel(item.status, t)}</span>
        <button
          className={`danger queue-delete-button ${deleting ? "is-busy" : ""}`}
          disabled={!canDelete || deleting}
          onClick={(event) => {
            event.stopPropagation();
            onDelete(item.paper_id);
          }}
          title={canDelete ? t("reader.actions.deleteQueue") : t("reader.actions.cannotDeleteProcessing")}
          type="button"
        >
          {deleting ? <InlineLoader compact label={t("common.deleting")} /> : t("common.delete")}
        </button>
        </div>
      </div>
      <h2>{item.title}</h2>
      {projectNames.length ? (
        <div className="inbox-project-match">
          <strong>{linkedProjectNames.length ? t("reader.linkedProjects") : t("reader.recommendedProjects")}</strong>
          <div>{projectNames.slice(0, 3).map((name) => <span key={name}>{name}</span>)}</div>
        </div>
      ) : null}
      <div className="inbox-paper-meta">
        <span>{item.arxiv_id || t("reader.localPaper")}</span>
        <span>{t("reader.fullTextStatus", { status: item.text_status || "pending" })}</span>
        {projectCount > 3 ? <span>{t("reader.projectCount", { count: projectCount })}</span> : null}
        {item.model ? <span>{item.model}</span> : null}
        {item.updated_at ? <span>{fmtDate(item.updated_at, i18n.resolvedLanguage || i18n.language)}</span> : null}
      </div>
      {item.error_message ? <p className="inbox-paper-error">{item.error_message}</p> : null}
    </article>
  );
}

function messageSourceLabel(source, t) {
  if (source === "analysis_prompt") return t("reader.chat.sourcePrompt");
  if (source === "analysis_report") return t("common.fullReport");
  if (source === "chat") return "Chat";
  return source || "";
}

function readerMessageKey(message, index) {
  const id = message?.id;
  return id === undefined || id === null || id === "" ? `reader-message-${index}` : String(id);
}

function readerQuestionLabel(content, t) {
  return String(content || "").replace(/\s+/g, " ").trim() || t("reader.chat.emptyQuestion");
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
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onFocus={() => setOpen(true)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      ref={navigatorRef}
    >
      <div className="reader-question-panel-shell">
        <div className="reader-question-panel" ref={panelRef}>
          {items.map((item) => {
            const active = item.key === activeQuestionKey;
            return (
              <button
                aria-current={active ? "true" : undefined}
                className={`reader-question-entry ${active ? "active" : ""}`}
                key={`question-entry-${item.key}`}
                onClick={() => onJump(item.key)}
                title={item.label}
                type="button"
              >
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div aria-expanded={open} className="reader-question-rail">
        {items.map((item) => {
          const active = item.key === activeQuestionKey;
          return (
            <button
              aria-label={t("reader.chat.jumpTo", { label: item.label })}
              aria-current={active ? "true" : undefined}
              className={`reader-question-line ${active ? "active" : ""}`}
              key={`question-line-${item.key}`}
              onClick={() => onJump(item.key)}
              title={item.label}
              type="button"
            ><span aria-hidden="true" /></button>
          );
        })}
      </div>
    </nav>
  ), document.body);
}

function ChatMessage({ deleting, message, navigationKey, onDelete }) {
  const { t, i18n } = useTranslation("papers");
  const isAssistant = message.role === "assistant";
  const numericId = Number(message.id);
  const persistedId = Number.isInteger(numericId) ? numericId : null;
  const isAnalysisSeed = ["analysis_prompt", "analysis_report"].includes(message.source);
  const canDelete = persistedId && persistedId > 0 && message.source === "chat" && onDelete;
  const isNavigationAnchor = message.source === "analysis_report" || (!isAssistant && message.source === "chat");
  const roleLabel = isAssistant ? t("reader.chatAssistant") : t("reader.chat.you");
  const sourceLabel = messageSourceLabel(message.source, t);
  return (
    <article
      className={`reader-message ${isAssistant ? "assistant" : "user"} ${isAnalysisSeed ? "analysis-seed" : ""} ${message.transient ? "transient" : ""}`}
      data-message-id={persistedId ?? undefined}
      data-reader-message={persistedId ? "true" : undefined}
      data-reader-question-key={isNavigationAnchor ? navigationKey : undefined}
    >
      <div className="reader-message-header">
        <div className="reader-message-identity">
          <i className="reader-message-avatar" aria-hidden="true">{isAssistant ? "AI" : t("reader.chat.you")}</i>
          <div><strong>{roleLabel}</strong>{sourceLabel ? <span>{sourceLabel}</span> : null}</div>
        </div>
        <div className="reader-message-badges">
          {message.model ? <span>{message.model}</span> : null}
          {message.created_at ? <span>{fmtDate(message.created_at, i18n.resolvedLanguage || i18n.language)}</span> : null}
          {message.streaming ? <span>{t("common.generating")}</span> : null}
          {message.context?.reference_paper_ids?.length ? <span>{t("reader.chat.referenceCount", { count: message.context.reference_paper_ids.length })}</span> : null}
        {canDelete ? (
          <button className="reader-message-delete" disabled={deleting} onClick={() => onDelete(persistedId)} type="button">
            {deleting ? t("common.deleting") : t("common.delete")}
          </button>
        ) : null}
        </div>
      </div>
      <div className="reader-message-body" data-message-content="true">
        {isAssistant ? (
          message.content ? <LazyMarkdownReport markdown={message.content} /> : <p className="muted">...</p>
        ) : (
          <p>{message.content}</p>
        )}
      </div>
    </article>
  );
}

function ProjectLinkControl({ linkedProjects, linking, onLink, paperId, projects }) {
  const { t } = useTranslation("papers");
  const linkedProjectIds = new Set((linkedProjects || []).map((item) => Number(item.project_id)));
  const label = !projects.length ? t("reader.projectLink.noProjects") : linking ? t("reader.projectLink.linking") : t("reader.projectLink.action");
  const options = [
    ["", label],
    ...projects.map((project) => ({
      disabled: linkedProjectIds.has(Number(project.id)),
      label: linkedProjectIds.has(Number(project.id)) ? t("reader.projectLink.linkedName", { name: project.name }) : project.name,
      value: String(project.id)
    }))
  ];
  return (
    <div className="project-link-control inbox-project-link-control">
      <span>{t("reader.projectLink.label")}</span>
      <WorkspaceSelect
        ariaLabel={t("reader.projectLink.aria")}
        className="inbox-project-link-select"
        disabled={!projects.length || linking}
        onChange={(value) => onLink(paperId, value)}
        options={options}
        value=""
      />
    </div>
  );
}

function ReaderDetail({
  activeTab,
  busy,
  chatSettings,
  deletingMessageId,
  detail,
  displayedMessages,
  linkingProject,
  message,
  obsidianCapability,
  onChatModelChange,
  onCancel,
  onDeleteMessage,
  onGenerate,
  onProjectContextChange,
  onProjectLink,
  onProjectUnlink,
  onReferencePapersSave,
  onRetry,
  onSave,
  onSendMessage,
  onSendQuestion,
  onTabChange,
  onTitleSave,
  projects,
  projectContextEnabled,
  referenceCandidates,
  savingReferencePapers,
  savingChatModel,
  setMessage
}) {
  const { t, i18n } = useTranslation("papers");
  const [selectedText, setSelectedText] = useState("");
  const [selectionContext, setSelectionContext] = useState(null);
  const [questionSuggestions, setQuestionSuggestions] = useState([]);
  const [questionError, setQuestionError] = useState("");
  const [generatingQuestions, setGeneratingQuestions] = useState(false);
  const [followUpPanelPosition, setFollowUpPanelPosition] = useState(null);
  const [referenceDialogOpen, setReferenceDialogOpen] = useState(false);
  const [referenceQuery, setReferenceQuery] = useState("");
  const [draftReferenceIds, setDraftReferenceIds] = useState([]);
  const [messageScroll, setMessageScroll] = useState({ activeQuestionKey: null, atBottom: true, max: 0, top: 0 });
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [savingTitle, setSavingTitle] = useState(false);
  const messagesRef = useRef(null);
  const chatInitializedRef = useRef(false);
  const latestTransientQuestionRef = useRef(null);
  const stickToBottomRef = useRef(true);
  const navigationItems = useMemo(() => {
    const hasUserQuestions = displayedMessages.some((item) => item.role === "user" && item.source === "chat");
    if (!hasUserQuestions) return [];
    return displayedMessages.flatMap((item, index) => {
      if (item.source === "analysis_report") {
        return [{ key: readerMessageKey(item, index), label: t("reader.chat.paperReport"), transient: false }];
      }
      if (item.role !== "user" || item.source !== "chat") return [];
      return [{
        key: readerMessageKey(item, index),
        label: readerQuestionLabel(item.content, t),
        transient: Boolean(item.transient)
      }];
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
    const next = {
      activeQuestionKey,
      atBottom,
      max,
      top
    };
    setMessageScroll((current) => (
      current.activeQuestionKey === next.activeQuestionKey &&
      current.atBottom === next.atBottom &&
      current.max === next.max &&
      current.top === next.top
        ? current
        : next
    ));
  }, []);

  const jumpToQuestion = useCallback((questionKey) => {
    const container = messagesRef.current;
    if (!container) return;
    const target = [...container.querySelectorAll("[data-reader-question-key]")]
      .find((element) => element.dataset.readerQuestionKey === String(questionKey));
    if (!target) return;
    const containerRect = container.getBoundingClientRect();
    const targetTop = target.getBoundingClientRect().top - containerRect.top + container.scrollTop - 10;
    stickToBottomRef.current = false;
    container.scrollTo({
      behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      top: Math.max(0, targetTop)
    });
  }, []);

  const jumpToBottom = useCallback((behavior = "smooth") => {
    const container = messagesRef.current;
    if (!container) return;
    stickToBottomRef.current = true;
    container.scrollTo({
      behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : behavior,
      top: container.scrollHeight
    });
  }, []);

  useEffect(() => {
    if (!selectedText) return undefined;

    function selectionIsInMessages(selection) {
      const root = messagesRef.current;
      const anchorNode = selection?.anchorNode;
      const focusNode = selection?.focusNode;
      return Boolean(root && anchorNode && focusNode && root.contains(anchorNode) && root.contains(focusNode));
    }

    function closeIfSelectionCleared() {
      const selection = window.getSelection?.();
      if (!selection || selection.rangeCount === 0 || !normalizePromptText(selection.toString()) || !selectionIsInMessages(selection)) {
        resetFollowUpSelection();
      }
    }

    function refreshPanelPosition() {
      const root = messagesRef.current;
      const selection = window.getSelection?.();
      if (!root || !selection || selection.rangeCount === 0) return;
      const anchorNode = selection.anchorNode;
      const focusNode = selection.focusNode;
      if (!anchorNode || !focusNode || !root.contains(anchorNode) || !root.contains(focusNode)) return;
      const rect = getSelectionRect(selection);
      if (rect) setFollowUpPanelPosition(getFollowUpPanelPosition(rect));
    }

    document.addEventListener("selectionchange", closeIfSelectionCleared);
    window.addEventListener("resize", refreshPanelPosition);
    window.addEventListener("scroll", refreshPanelPosition, true);
    return () => {
      document.removeEventListener("selectionchange", closeIfSelectionCleared);
      window.removeEventListener("resize", refreshPanelPosition);
      window.removeEventListener("scroll", refreshPanelPosition, true);
    };
  }, [selectedText]);

  useEffect(() => {
    if (activeTab !== "chat" && selectedText) resetFollowUpSelection();
  }, [activeTab, selectedText]);

  useEffect(() => {
    if (activeTab !== "chat") {
      chatInitializedRef.current = false;
      return undefined;
    }
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
  }, [activeTab, updateMessageScroll]);

  useEffect(() => {
    if (activeTab !== "chat" || !latestTransientQuestionKey) return undefined;
    if (latestTransientQuestionRef.current === latestTransientQuestionKey) return undefined;
    latestTransientQuestionRef.current = latestTransientQuestionKey;
    const frame = requestAnimationFrame(() => jumpToBottom("auto"));
    return () => cancelAnimationFrame(frame);
  }, [activeTab, jumpToBottom, latestTransientQuestionKey]);

  useEffect(() => {
    if (activeTab !== "chat") return undefined;
    const container = messagesRef.current;
    if (!container || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return undefined;
    const messages = [...container.querySelectorAll("[data-reader-message], .reader-message")];
    if (!messages.length) return undefined;
    const revealMidpoint = () => {
      const rect = container.getBoundingClientRect();
      return rect.top + rect.height / 2;
    };

    messages.forEach((element, index) => {
      element.style.setProperty("--reader-message-order", String(Math.min(index, 6)));
      element.classList.add(element.getBoundingClientRect().top < revealMidpoint() ? "reveal-from-top" : "reveal-from-bottom");
    });
    container.classList.add("is-reveal-ready");

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) {
          entry.target.classList.remove("is-scroll-visible");
          return;
        }
        entry.target.classList.remove("reveal-from-top", "reveal-from-bottom");
        entry.target.classList.add(entry.boundingClientRect.top < revealMidpoint() ? "reveal-from-top" : "reveal-from-bottom");
        requestAnimationFrame(() => entry.target.classList.add("is-scroll-visible"));
      });
    }, { root: container, rootMargin: "-5% 0px -5% 0px", threshold: 0.08 });

    messages.forEach((element) => observer.observe(element));
    return () => {
      observer.disconnect();
      container.classList.remove("is-reveal-ready");
      messages.forEach((element) => element.classList.remove("is-scroll-visible", "reveal-from-top", "reveal-from-bottom"));
    };
  }, [activeTab, displayedMessages.length]);

  useEffect(() => {
    if (activeTab !== "chat") return undefined;
    const container = messagesRef.current;
    if (!container) return undefined;
    const syncMessageViewport = () => {
      if (stickToBottomRef.current) container.scrollTop = container.scrollHeight;
      updateMessageScroll();
    };
    const frame = requestAnimationFrame(syncMessageViewport);
    const resizeObserver = new ResizeObserver(syncMessageViewport);
    resizeObserver.observe(container);
    [...container.children].forEach((child) => resizeObserver.observe(child));
    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
    };
  }, [activeTab, displayedMessages.length, updateMessageScroll]);

  if (!detail?.paper) {
    return (
      <div className="empty-detail">
        <h2>{t("reader.empty.title")}</h2>
        <p>{t("reader.empty.description")}</p>
      </div>
    );
  }
  const paper = detail.paper;
  const report = detail.paper_report || {};
  const ready = report.status === "done" && String(report.report_markdown || "").trim();
  const canRetry = ["done", "failed", "cancelled"].includes(report.status);
  const linkedProjects = detail.linked_projects || [];
  const recommendations = detail.project_recommendations || [];
  const activeRecommendations = recommendations.filter(
    (recommendation) => ["pending", "accepted"].includes(recommendation.state)
  );
  const contextProjectNames = [...new Set([
    ...linkedProjects.map((project) => project.project_name),
    ...activeRecommendations.map((recommendation) => recommendation.project_name)
  ].filter(Boolean))];
  const hasProjectContext = contextProjectNames.length > 0;
  const referencePapers = detail.reference_papers || [];
  const referencePaperMap = new Map([
    ...referencePapers.map((item) => [Number(item.paper_id), item]),
    ...(referenceCandidates || []).map((item) => [Number(item.paper_id), item])
  ]);
  const normalizedReferenceQuery = referenceQuery.trim().toLocaleLowerCase();
  const visibleReferenceCandidates = [...referencePaperMap.values()]
    .filter((item) => Number(item.paper_id) !== Number(paper.id))
    .filter((item) => {
      if (!normalizedReferenceQuery) return true;
      return `${item.title || ""} ${item.arxiv_id || ""}`.toLocaleLowerCase().includes(normalizedReferenceQuery);
    });
  const chatModelOptions = chatModelList(chatSettings || {});
  const chatModelValue = currentChatModelValue(chatSettings || {});
  const smartSaveDisabled = busy || !obsidianCapability?.available;
  const obsidianHint = obsidianCapability?.disabledReason || t("reader.obsidian.configureHint");
  const selectedChatModelValue = chatModelOptions.some((option) => option.value === chatModelValue)
    ? chatModelValue
    : "";
  const chatModelSelectOptions = chatModelOptions.length
    ? [{ label: t("reader.chat.selectModel"), value: "" }, ...chatModelOptions]
    : [["", t("reader.chat.noModel")]];

  function beginTitleEdit() {
    setTitleDraft(paper.title || "");
    setEditingTitle(true);
  }

  function cancelTitleEdit() {
    setTitleDraft(paper.title || "");
    setEditingTitle(false);
  }

  async function saveTitle(event) {
    event.preventDefault();
    const nextTitle = titleDraft.trim();
    if (!nextTitle || nextTitle === String(paper.title || "").trim()) {
      cancelTitleEdit();
      return;
    }
    setSavingTitle(true);
    const saved = await onTitleSave(paper.id, nextTitle);
    setSavingTitle(false);
    if (saved) setEditingTitle(false);
  }

  function resetFollowUpSelection() {
    setSelectedText("");
    setSelectionContext(null);
    setQuestionSuggestions([]);
    setQuestionError("");
    setFollowUpPanelPosition(null);
  }

  function openReferenceDialog() {
    setDraftReferenceIds(referencePapers.map((item) => Number(item.paper_id)));
    setReferenceQuery("");
    setReferenceDialogOpen(true);
  }

  function toggleReferencePaper(referencePaperId) {
    const id = Number(referencePaperId);
    setDraftReferenceIds((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      if (current.length >= 3) return current;
      return [...current, id];
    });
  }

  async function saveReferencePapers() {
    const saved = await onReferencePapersSave(paper.id, draftReferenceIds);
    if (saved) setReferenceDialogOpen(false);
  }

  function clearSelection() {
    resetFollowUpSelection();
    window.getSelection?.().removeAllRanges?.();
  }

  function updateSelectedText() {
    const root = messagesRef.current;
    const selection = window.getSelection?.();
    if (!root || !selection || selection.rangeCount === 0) return;
    const anchorNode = selection.anchorNode;
    const focusNode = selection.focusNode;
    if (!anchorNode || !focusNode || !root.contains(anchorNode) || !root.contains(focusNode)) return;
    const anchorContent = getClosestMessageContent(anchorNode, root);
    const focusContent = getClosestMessageContent(focusNode, root);
    if (!anchorContent || anchorContent !== focusContent) {
      clearSelection();
      return;
    }
    const anchorMessage = anchorContent.closest("[data-message-id]");
    const messageId = Number(anchorMessage?.dataset?.messageId);
    if (!Number.isInteger(messageId)) {
      clearSelection();
      return;
    }
    const text = normalizePromptText(selection.toString());
    if (!text) return;
    const rect = getSelectionRect(selection);
    if (!rect) return;
    const contextText = getSelectionContextText(selection, anchorContent);
    if (!contextText) {
      clearSelection();
      return;
    }
    setSelectedText(text.slice(0, SELECTED_TEXT_LIMIT));
    setSelectionContext({
      messageId,
      contextText
    });
    setFollowUpPanelPosition(getFollowUpPanelPosition(rect));
    setQuestionSuggestions([]);
    setQuestionError("");
  }

  async function generateQuestions() {
    if (!selectedText || !selectionContext?.messageId) return;
    setGeneratingQuestions(true);
    setQuestionError("");
    setQuestionSuggestions([]);
    try {
      const result = await postJson(`/api/reader/papers/${paper.id}/follow-up-questions`, {
        selected_text: selectedText,
        anchor_message_id: selectionContext.messageId,
        context_text: selectionContext.contextText
      });
      setQuestionSuggestions(result.questions || []);
    } catch (error) {
      setQuestionError(error.message);
    } finally {
      setGeneratingQuestions(false);
    }
  }

  async function sendSuggestedQuestion(question) {
    clearSelection();
    await onSendQuestion(question);
  }

  function handleComposerKeyDown(event) {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.isComposing ||
      event.nativeEvent?.isComposing ||
      event.nativeEvent?.keyCode === 229
    ) {
      return;
    }
    event.preventDefault();
    if (busy || !message.trim()) return;
    event.currentTarget.form?.requestSubmit();
  }

  return (
    <div className="detail-card inbox-detail-card reader-detail-card reader-detail-transition">
      <div className="detail-main">
        <div className="detail-title inbox-detail-title reader-detail-title">
          <span className="inbox-detail-eyebrow">{t("reader.detail.eyebrow", { id: paper.arxiv_id || t("reader.localPaper") })}</span>
          <h2>{paper.title}</h2>
          <p className="inbox-detail-authors">
            {(paper.authors || []).slice(0, 8).join(", ") || t("common.noAuthors")}
          </p>
          <div className="inbox-detail-meta">
            <a href={paper.link} target="_blank" rel="noreferrer">{paper.arxiv_id}</a>
            <span>{(paper.categories || []).join(" · ") || "arXiv"}</span>
            <span>{t("reader.fullTextStatus", { status: paper.text_status || "pending" })}</span>
          </div>
          {paper.pdf_path ? (
            <div className="inbox-detail-meta reader-file-meta">
              <a href={`/api/reader/papers/${paper.id}/pdf`} target="_blank" rel="noreferrer">{t("reader.actions.openPdf")}</a>
              <span>{paper.pdf_path}</span>
            </div>
          ) : null}
        </div>

        <div aria-label={t("reader.detail.tabsAria")} className="reader-tabs" role="tablist">
          <button aria-selected={activeTab === "analysis"} className={activeTab === "analysis" ? "active" : ""} onClick={() => onTabChange("analysis")} role="tab" type="button">
            <i aria-hidden="true">01</i><span><strong>{t("reader.tabs.report")}</strong><small>{t("reader.tabs.reportBadge")}</small></span>
          </button>
          <button aria-selected={activeTab === "chat"} className={activeTab === "chat" ? "active" : ""} onClick={() => onTabChange("chat")} role="tab" type="button">
            <i aria-hidden="true">02</i><span><strong>{t("reader.tabs.chat")}</strong><small>{t("reader.tabs.chatBadge")}</small></span>
          </button>
          <button aria-selected={activeTab === "meta"} className={activeTab === "meta" ? "active" : ""} onClick={() => onTabChange("meta")} role="tab" type="button">
            <i aria-hidden="true">03</i><span><strong>{t("reader.tabs.metadata")}</strong><small>{t("reader.tabs.metadataBadge")}</small></span>
          </button>
        </div>

        {activeTab === "analysis" ? (
          <div className="reader-tab-panel reader-analysis-panel" role="tabpanel">
            <section className="section inbox-content-section reader-project-section">
              <header className="inbox-section-heading">
                <div><span>{t("reader.sections.context")}</span><h3>{t("reader.sections.projectLinks")}</h3></div>
                <em>{linkedProjects.length + recommendations.length}</em>
              </header>
              <ProjectLinkControl linkedProjects={linkedProjects} linking={linkingProject} onLink={onProjectLink} paperId={paper.id} projects={projects} />
              <div className="evidence-list">
                {linkedProjects.map((project) => (
                  <article className="evidence linked-project-evidence" key={`linked-${project.project_id}`}>
                    <div>
                      <Link className="reader-project-link" to={`/projects/${encodeURIComponent(String(project.project_id))}`}>
                        <strong>{project.project_name} · {t(`projectPaperRelation.${project.relation}`, { ns: "common", defaultValue: project.relation })} · {t("reader.projectLink.linked")}</strong>
                        <p>{project.note || t("reader.projectLink.manualNote")}</p>
                      </Link>
                    </div>
                    <button
                      className="reader-project-unlink"
                      disabled={linkingProject}
                      onClick={() => onProjectUnlink(paper.id, project.project_id)}
                      type="button"
                    >{t("reader.projectLink.unlink")}</button>
                  </article>
                ))}
                {recommendations.map((recommendation) => (
                  <article className="evidence" key={`${recommendation.project_id}-${recommendation.state}`}>
                    <Link className="reader-project-link" to={`/projects/${encodeURIComponent(String(recommendation.project_id))}`}>
                      <strong>{recommendation.project_name} · {t(`relation.${recommendation.relation_type}`, { defaultValue: recommendation.relation_type })} · {t(`workflowState.${recommendation.state}`, { defaultValue: recommendation.state })}</strong>
                      <p>{recommendation.reason || t("inbox.noRecommendationReason")}</p>
                    </Link>
                  </article>
                ))}
                {!linkedProjects.length && !recommendations.length ? <p className="summary">{t("inbox.noProjectRecommendations")}</p> : null}
              </div>
            </section>
            <section className="section inbox-content-section reader-report-section">
              <header className="inbox-section-heading">
                <div><span>{t("inbox.sections.deepReading")}</span><h3>{t("common.fullReport")}</h3></div>
                <em>{reportStatusLabel(report.status, t)}</em>
              </header>
              <div className={`report-state ${report.status || "missing"}`}>
                <strong>{reportStatusLabel(report.status, t)}</strong>
                {report.error_message ? <p>{report.error_message}</p> : null}
                {report.model ? <p>{report.model_provider_id ? `${report.model_provider_id} · ` : ""}{report.model}</p> : null}
                {report.updated_at ? <p>{t("common.updatedAt", { date: fmtDate(report.updated_at, i18n.resolvedLanguage || i18n.language) })}</p> : null}
              </div>
              <div className="detail-actions inbox-primary-actions reader-report-actions">
                <button
                  aria-label={t("reader.obsidian.smartSaveAria")}
                  className={ready ? "primary" : ""}
                  disabled={smartSaveDisabled}
                  onClick={() => onSave(paper.id)}
                  title={obsidianCapability?.available ? t("reader.obsidian.smartSaveTitle") : obsidianHint}
                  type="button"
                >{t("reader.obsidian.smartSave")}</button>
                {report.status !== "processing" && report.status !== "queued" && !ready ? (
                  <button className="primary" disabled={busy} onClick={() => onGenerate(paper.id, false)} type="button">{t("inbox.actions.generateReport")}</button>
                ) : null}
                {report.status === "queued" ? <button disabled={busy} onClick={() => onCancel(paper.id)} type="button">{t("reader.actions.cancelQueue")}</button> : null}
                {canRetry ? <button className="primary" disabled={busy} onClick={() => onRetry(paper.id)} type="button">{t("reader.actions.requeue")}</button> : null}
              </div>
              {!obsidianCapability?.available ? <p className="inbox-decision-hint capability-hint">{obsidianHint}</p> : null}
              <div className="reader-report-content">
                {ready ? <LazyMarkdownReport markdown={report.report_markdown} /> : <p className="muted">{t("reader.reportNotGenerated")}</p>}
              </div>
            </section>
          </div>
        ) : null}

        {activeTab === "chat" ? (
          <section className="reader-chat inbox-content-section" role="tabpanel">
            <header className="inbox-section-heading reader-chat-heading">
              <div><span>{t("reader.chat.eyebrow")}</span><h3>{t("reader.chat.title")}</h3></div>
              <em>{t("reader.chat.messageCount", { count: displayedMessages.length })}</em>
            </header>
            <ReaderQuestionNavigator
              activeQuestionKey={messageScroll.activeQuestionKey}
              items={navigationItems}
              onJump={jumpToQuestion}
            />
            <div className="reader-messages-shell">
              <div className="reader-messages" onKeyUp={updateSelectedText} onMouseUp={updateSelectedText} onScroll={updateMessageScroll} ref={messagesRef}>
                {displayedMessages.length ? displayedMessages.map((item, index) => (
                  <ChatMessage
                    deleting={deletingMessageId === Number(item.id)}
                    key={readerMessageKey(item, index)}
                    message={item}
                    navigationKey={readerMessageKey(item, index)}
                    onDelete={onDeleteMessage}
                  />
                )) : <p className="muted">{t("reader.chat.empty")}</p>}
              </div>
              <input
                aria-label={t("reader.chat.scrollAria")}
                className={`reader-message-scrollbar ${messageScroll.max > 0 ? "is-visible" : ""}`}
                max={Math.max(1, messageScroll.max)}
                min="0"
                onChange={(event) => {
                  if (!messagesRef.current) return;
                  messagesRef.current.scrollTop = Number(event.target.value);
                  updateMessageScroll();
                }}
                step="1"
                type="range"
                value={Math.min(messageScroll.top, Math.max(1, messageScroll.max))}
              />
              {!messageScroll.atBottom && messageScroll.max > 0 ? (
                <button
                  aria-label={t("reader.chat.jumpBottom")}
                  className="reader-scroll-to-bottom"
                  onClick={() => jumpToBottom()}
                  title={t("reader.chat.jumpLatest")}
                  type="button"
                >
                  <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
                    <path d="m6.5 9 5.5 5.5L17.5 9" />
                  </svg>
                </button>
              ) : null}
            </div>
            {selectedText && followUpPanelPosition ? createPortal((
              <div
                className="reader-followups reader-followups-floating vision-reader-followups"
                onMouseDown={(event) => event.preventDefault()}
                style={{
                  left: `${followUpPanelPosition.left}px`,
                  top: `${followUpPanelPosition.top}px`,
                  width: `${followUpPanelPosition.width}px`
                }}
              >
                <div className="reader-followups-header">
                  <strong>{t("reader.chat.followups")}</strong>
                  <button onClick={clearSelection} type="button">{t("common.clear")}</button>
                </div>
                <p className="reader-followups-selection">{selectedText.length > 260 ? `${selectedText.slice(0, 260)}...` : selectedText}</p>
                <div className="reader-followups-actions">
                  <button disabled={generatingQuestions || busy} onClick={generateQuestions} type="button">
                    {generatingQuestions ? <InlineLoader compact label={t("common.generating")} /> : t("reader.chat.generateFollowups")}
                  </button>
                </div>
                {questionError ? <div className="error-line">{questionError}</div> : null}
                {questionSuggestions.length ? (
                  <div className="reader-question-list">
                    {questionSuggestions.map((question, index) => (
                      <button disabled={busy} key={`${question}-${index}`} onClick={() => sendSuggestedQuestion(question)} type="button">
                        {question}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ), document.body) : null}
            <div className="reader-chat-composer">
              <div className="reader-chat-toolbar">
                <div className="reader-chat-model-control">
                  <span>{t("reader.chat.model")}</span>
                  <WorkspaceSelect
                    ariaLabel={t("reader.chat.selectModel")}
                    className="reader-chat-model-select"
                    disabled={!chatSettings || !chatModelOptions.length || savingChatModel || busy}
                    onChange={onChatModelChange}
                    options={chatModelSelectOptions}
                    value={selectedChatModelValue}
                  />
                </div>
                <label
                  className={`reader-project-context-control ${hasProjectContext ? "" : "is-disabled"}`}
                  title={hasProjectContext
                    ? t("reader.chat.projectContextTitle", { projects: contextProjectNames.join(t("common.listSeparator")) })
                    : t("reader.chat.noProjectContextTitle")}
                >
                  <input
                    checked={hasProjectContext && projectContextEnabled}
                    disabled={!hasProjectContext || busy}
                    onChange={(event) => onProjectContextChange(event.target.checked)}
                    type="checkbox"
                  />
                  <i aria-hidden="true" className="reader-context-checkmark">✓</i>
                  <span>
                    {t("reader.chat.useProjectContext")}
                    <small>{hasProjectContext ? t("reader.projectCount", { count: contextProjectNames.length }) : t("reader.chat.noProjects")}</small>
                  </span>
                </label>
                <button className="reader-reference-button" onClick={openReferenceDialog} type="button">
                  {t("reader.chat.addReferences")}
                </button>
              </div>
              {referencePapers.length ? (
                <div className="reader-reference-tags">
                  <span>{t("reader.chat.references")}</span>
                  {referencePapers.map((reference) => (
                    <button
                      disabled={savingReferencePapers || busy}
                      key={reference.paper_id}
                      onClick={() => onReferencePapersSave(
                        paper.id,
                        referencePapers
                          .filter((item) => Number(item.paper_id) !== Number(reference.paper_id))
                          .map((item) => Number(item.paper_id))
                      )}
                      title={t("reader.chat.removeReference")}
                      type="button"
                    >
                      <span>{reference.title || reference.arxiv_id}</span>
                      <strong aria-hidden="true" className="reader-reference-remove">×</strong>
                    </button>
                  ))}
                </div>
              ) : null}
              <form className="reader-composer" onSubmit={onSendMessage}>
                <textarea
                  disabled={busy}
                  onChange={(event) => setMessage(event.target.value)}
                  onKeyDown={handleComposerKeyDown}
                  placeholder={t("reader.chat.placeholder")}
                  value={message}
                />
                <button className={busy ? "is-busy" : undefined} disabled={busy || !message.trim()} type="submit">
                  {busy ? <InlineLoader compact label={t("common.sending")} /> : t("common.send")}
                </button>
              </form>
              <WorkspaceDialog
                className="reference-picker-dialog"
                description={t("reader.reference.description")}
                eyebrow={t("reader.referenceEyebrow")}
                footer={(
                  <>
                    <span>{t("reader.reference.selected", { count: draftReferenceIds.length, max: 3 })}</span>
                    <div>
                      <button disabled={savingReferencePapers} onClick={() => setReferenceDialogOpen(false)} type="button">{t("common.cancel")}</button>
                      <button className="workspace-dialog-primary" disabled={savingReferencePapers} onClick={saveReferencePapers} type="button">
                        {savingReferencePapers ? t("common.saving") : t("reader.reference.apply")}<i aria-hidden="true">→</i>
                      </button>
                    </div>
                  </>
                )}
                icon="RF"
                onClose={() => {
                  if (!savingReferencePapers) setReferenceDialogOpen(false);
                }}
                open={referenceDialogOpen}
                title={t("reader.chat.addReferences")}
              >
                <div className="reader-reference-body workspace-reference-body">
                  <label className="workspace-reference-search">
                    <svg aria-hidden="true" fill="none" viewBox="0 0 20 20" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7"><circle cx="8.5" cy="8.5" r="5" /><path d="m12.2 12.2 4 4" /></svg>
                    <input
                      autoFocus
                      onChange={(event) => setReferenceQuery(event.target.value)}
                      placeholder={t("reader.reference.searchPlaceholder")}
                      type="search"
                      value={referenceQuery}
                    />
                    <span>{t("reader.paperCount", { count: visibleReferenceCandidates.length })}</span>
                  </label>
                  <div className="reader-reference-list">
                    {visibleReferenceCandidates.length ? visibleReferenceCandidates.map((candidate) => {
                      const candidateId = Number(candidate.paper_id);
                      const selected = draftReferenceIds.includes(candidateId);
                      const available = candidate.text_status === "complete";
                      return (
                        <label className={`${selected ? "selected" : ""} ${!available ? "is-disabled" : ""}`} key={candidateId}>
                          <input
                            checked={selected}
                            disabled={!available || (!selected && draftReferenceIds.length >= 3)}
                            onChange={() => toggleReferencePaper(candidateId)}
                            type="checkbox"
                          />
                          <i aria-hidden="true" className="reader-reference-checkmark">✓</i>
                          <span>
                            <strong>{candidate.title || t("reader.untitledPaper")}</strong>
                            <small>{candidate.arxiv_id || t("reader.paperFallback", { id: candidateId })} · {available ? t("reader.reference.available") : t("reader.reference.unavailable")}</small>
                          </span>
                        </label>
                      );
                    }) : <p className="workspace-dialog-empty">{t("reader.reference.empty")}</p>}
                  </div>
                </div>
              </WorkspaceDialog>
            </div>
          </section>
        ) : null}

        {activeTab === "meta" ? (
          <section className="reader-meta-section inbox-content-section" role="tabpanel">
            <header className="inbox-section-heading reader-meta-heading">
              <div><span>{t("reader.meta.eyebrow")}</span><h3>{t("reader.meta.title")}</h3></div>
              <em>{t("reader.meta.itemCount", { count: 8 })}</em>
            </header>
            <div className="reader-meta-grid">
            <div className="reader-meta-item wide">
              <div className="reader-meta-label-row">
                <span>{t("reader.meta.paperTitle")}</span>
                {!editingTitle ? (
                  <button aria-label={t("reader.meta.editTitleAria")} className="reader-meta-edit-button" onClick={beginTitleEdit} title={t("reader.meta.editTitle")} type="button">
                    <svg aria-hidden="true" fill="none" viewBox="0 0 20 20" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7"><path d="m4 14.8.7-3.3L13 3.2a1.7 1.7 0 0 1 2.4 0l1.4 1.4a1.7 1.7 0 0 1 0 2.4l-8.3 8.3-3.3.7Z" /><path d="m11.8 4.4 3.8 3.8M4.7 11.5l3.8 3.8" /></svg>
                  </button>
                ) : null}
              </div>
              {editingTitle ? (
                <form className="reader-title-editor" onSubmit={saveTitle}>
                  <input
                    aria-label={t("reader.meta.paperTitle")}
                    autoFocus
                    disabled={savingTitle}
                    onChange={(event) => setTitleDraft(event.target.value)}
                    value={titleDraft}
                  />
                  <div>
                    <button disabled={savingTitle} onClick={cancelTitleEdit} type="button">{t("common.cancel")}</button>
                    <button className="primary" disabled={savingTitle || !titleDraft.trim()} type="submit">{savingTitle ? t("common.saving") : t("common.save")}</button>
                  </div>
                </form>
              ) : <strong>{paper.title || t("common.notRecorded")}</strong>}
            </div>
            <div className="reader-meta-item">
              <span>arXiv</span>
              <strong>{paper.arxiv_id || t("common.notRecorded")}</strong>
            </div>
            <div className="reader-meta-item">
              <span>{t("reader.meta.categories")}</span>
              <strong>{(paper.categories || []).join(", ") || t("common.notRecorded")}</strong>
            </div>
            <div className="reader-meta-item">
              <span>{t("reader.meta.txtStatus")}</span>
              <strong>{paper.text_status || "pending"}</strong>
            </div>
            <div className="reader-meta-item">
              <span>PDF</span>
              <strong>{paper.pdf_path ? t("reader.meta.cached") : t("reader.meta.notCached")}</strong>
            </div>
            <div className="reader-meta-item wide">
              <span>{t("reader.meta.authors")}</span>
              <strong>{(paper.authors || []).join(", ") || t("common.notRecorded")}</strong>
            </div>
            <div className="reader-meta-item wide">
              <span>{t("reader.meta.txtPath")}</span>
              <strong className="reader-meta-value is-path">{paper.text_path || t("reader.meta.notGenerated")}</strong>
            </div>
            <div className="reader-meta-item wide">
              <span>{t("reader.meta.pdfPath")}</span>
              <strong className="reader-meta-value is-path">{paper.pdf_path || t("reader.meta.notCached")}</strong>
            </div>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

export function ReaderView({ importOpen, onClosePaperImport, onOpenPaperImport, onSelectPaper, setStatusMessage, targetPaperId, targetPaperKey }) {
  const { t, i18n } = useTranslation("papers");
  const cache = useApiCacheClient();
  const queueNavigationRef = useRef(false);
  const internalRouteSelectionRef = useRef(null);
  const [activePaperId, setActivePaperId] = useState(null);
  const [activeTab, setActiveTab] = useState("analysis");
  const [message, setMessage] = useState("");
  const [urls, setUrls] = useState("");
  const [webUrls, setWebUrls] = useState("");
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [statusFilter, setStatusFilter] = useState("all");
  const [projectFilter, setProjectFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [queueQuery, setQueueQuery] = useState("");
  const [queuePage, setQueuePage] = useState(0);
  const [queueFiltersOpen, setQueueFiltersOpen] = useState(false);
  const [pendingUser, setPendingUser] = useState(null);
  const [streamingAssistant, setStreamingAssistant] = useState(null);
  const [deletingMessageId, setDeletingMessageId] = useState(null);
  const [deletingReportId, setDeletingReportId] = useState(null);
  const [linkingProjectPaperId, setLinkingProjectPaperId] = useState(null);
  const [savingChatModel, setSavingChatModel] = useState(false);
  const [projectContextPreferences, setProjectContextPreferences] = useState({});
  const [savingReferencePapers, setSavingReferencePapers] = useState(false);
  const [recencyClock, setRecencyClock] = useState(() => Date.now());
  const queuePageSize = 10;

  useEffect(() => {
    const timer = window.setInterval(() => setRecencyClock(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const debouncedQueueQuery = useDebouncedValue(queueQuery, 700, () => {
    queueNavigationRef.current = true;
    setQueuePage(0);
  });
  const queueSearchQuery = debouncedQueueQuery.trim();
  const readerListQueryString = useMemo(() => {
    const params = new URLSearchParams({
      limit: String(queuePageSize),
      offset: String(queuePage * queuePageSize)
    });
    if (queueSearchQuery) params.set("q", queueSearchQuery);
    if (statusFilter !== "all") params.set("status", statusFilter);
    if (projectFilter !== "all") params.set("project_id", projectFilter);
    if (sourceFilter !== "all") params.set("source", sourceFilter);
    return params.toString();
  }, [projectFilter, queuePage, queueSearchQuery, sourceFilter, statusFilter]);
  const readerListQuery = useCachedApi(
    ["reader", "papers", readerListQueryString],
    () => api(`/api/reader/papers?${readerListQueryString}`),
    { staleTime: 60000 }
  );
  const referenceCandidatesQuery = useCachedApi(
    ["reader", "papers", "reference-candidates"],
    () => api("/api/reader/papers?limit=300&offset=0"),
    { staleTime: 60000 }
  );
  const paperReportsSummaryQuery = useCachedApi(["paper-reports", "summary"], () => api("/api/paper-reports/summary"), { staleTime: 15000 });
  const jobStatusQuery = useCachedApi(["jobs", "status"], () => api("/api/jobs/status"), { staleTime: 5000 });
  const settingsQuery = useCachedApi(["settings"], () => api("/api/settings"), { staleTime: Infinity });
  const projectsQuery = useCachedApi(["projects"], () => api("/api/projects"), { staleTime: 60000 });
  const detailQuery = useCachedApi(
    ["reader", "paper", String(activePaperId || "")],
    () => api(`/api/reader/papers/${activePaperId}`),
    { enabled: Boolean(activePaperId), staleTime: 60000 }
  );
  const handleCapabilityError = useCallback((error) => setStatusMessage(error.message), [setStatusMessage]);
  const listData = readerListQuery.data || {};
  const items = listData.items || [];
  const stats = paperReportsSummaryQuery.data?.stats || listData.stats || {};
  const queueStatus = jobStatusQuery.data?.scheduler?.paper_report_queue || {};
  const projects = projectsQuery.data?.items || [];
  const projectFilterOptions = useMemo(() => [
    ["all", t("reader.filters.allProjects")],
    ...projects.map((project) => [String(project.id), project.name])
  ], [projects, t]);
  const reportFilters = REPORT_FILTER_CODES.map((value) => [value, t(`reportStatus.${value}`)]);
  const sourceFilterOptions = paperSourceFilterOptions(t);
  const readerSettings = settingsQuery.data?.settings || null;
  const obsidianCapability = useObsidianCapability({ settings: readerSettings, onError: handleCapabilityError });

  const detail = activePaperId ? detailQuery.data || null : null;
  const loading = !readerListQuery.hasData || !paperReportsSummaryQuery.hasData || !jobStatusQuery.hasData || !settingsQuery.hasData || !projectsQuery.hasData;
  const detailLoading = Boolean(activePaperId) && !detailQuery.hasData;
  const baseMessages = detail?.reader_messages || [];
  const detailPaperId = Number(detail?.paper?.id || 0);
  const hasProjectContext = Boolean(
    detail?.linked_projects?.length ||
    detail?.project_recommendations?.some((recommendation) => ["pending", "accepted"].includes(recommendation.state))
  );
  const projectContextEnabled = hasProjectContext && projectContextPreferences[detailPaperId] !== false;
  const displayedMessages = useMemo(() => {
    const messages = [...baseMessages];
    if (
      pendingUser &&
      Number(pendingUser.paper_id) === detailPaperId &&
      !hasPersistedPendingUser(baseMessages, pendingUser)
    ) {
      messages.push(pendingUser);
    }
    if (streamingAssistant && Number(streamingAssistant.paper_id) === detailPaperId) {
      messages.push(streamingAssistant);
    }
    return messages;
  }, [baseMessages, detailPaperId, pendingUser, streamingAssistant]);
  const visibleItems = items;
  const queueTotal = Number(listData.total ?? (queuePage * queuePageSize + items.length));
  const resolvedQueuePageCount = Math.max(1, Math.ceil(queueTotal / queuePageSize));
  const queuePageCount = readerListQuery.hasData
    ? resolvedQueuePageCount
    : Math.max(queuePage + 1, resolvedQueuePageCount);
  const queueCurrentPage = queuePage + 1;
  const hasQueueFilters = Boolean(
    queueSearchQuery || statusFilter !== "all" || projectFilter !== "all" || sourceFilter !== "all"
  );
  const queueSearchPending = queueQuery.trim() !== queueSearchQuery;
  const queueActiveFilterCount = [
    queueQuery.trim(),
    statusFilter !== "all",
    projectFilter !== "all",
    sourceFilter !== "all"
  ].filter(Boolean).length;
  const queueActiveFilterLabels = [
    statusFilter !== "all" ? reportFilters.find(([value]) => value === statusFilter)?.[1] || statusFilter : "",
    projectFilter !== "all" ? t("reader.filters.projectValue", { project: projectFilterOptions.find(([value]) => value === projectFilter)?.[1] || projectFilter }) : "",
    sourceFilter !== "all" ? paperSourceFilterLabel(sourceFilter, t) : "",
    queueQuery.trim() ? t("library.filters.searchValue", { query: queueQuery.trim() }) : ""
  ].filter(Boolean);
  const activeReportCount = Number(stats.queued || 0) + Number(stats.processing || 0);

  function changeQueueFilter(setter, value) {
    queueNavigationRef.current = true;
    setQueuePage(0);
    setter(value);
  }

  function clearQueueFilters() {
    queueNavigationRef.current = true;
    setQueuePage(0);
    setQueueQuery("");
    setStatusFilter("all");
    setProjectFilter("all");
    setSourceFilter("all");
  }

  function changeQueuePage(nextPage) {
    const normalizedPage = Math.max(0, Math.min(queuePageCount - 1, nextPage));
    if (normalizedPage === queuePage) return;
    queueNavigationRef.current = true;
    setQueuePage(normalizedPage);
  }

  function selectQueuePaper(paperId, options = {}) {
    const numericPaperId = Number(paperId);
    if (!numericPaperId) return;
    if (onSelectPaper) {
      internalRouteSelectionRef.current = numericPaperId;
      onSelectPaper(numericPaperId, options);
    }
    setActivePaperId(numericPaperId);
  }

  useEffect(() => {
    if (!readerListQuery.hasData || readerListQuery.loading) return;
    if (queuePage + 1 <= queuePageCount) return;
    setQueuePage(Math.max(0, queuePageCount - 1));
  }, [queuePage, queuePageCount, readerListQuery.hasData, readerListQuery.loading]);

  const refresh = useCallback(async () => {
    const [data] = await Promise.all([
      readerListQuery.refresh({ force: true }),
      jobStatusQuery.refresh({ force: true }),
      paperReportsSummaryQuery.refresh({ force: true }),
      activePaperId ? detailQuery.refresh({ force: true }) : Promise.resolve(null)
    ]);
    const nextItems = data.items || [];
    const pendingRouteId = Number(internalRouteSelectionRef.current || 0);
    if (pendingRouteId && nextItems.some((item) => Number(item.paper_id) === pendingRouteId)) {
      setActivePaperId(pendingRouteId);
      return;
    }
    const routePaperId = Number(targetPaperId || 0);
    const routePaperVisible = routePaperId && nextItems.some((item) => item.paper_id === routePaperId);
    if (routePaperId && (!queueSearchQuery || routePaperVisible)) {
      setActivePaperId(routePaperId);
      return;
    }
    const currentActiveId = Number(activePaperId || 0);
    const activeStillExists = currentActiveId && nextItems.some((item) => item.paper_id === currentActiveId);
    const nextId = activeStillExists
      ? currentActiveId
      : nextItems[0]?.paper_id;
    if (nextId) {
      selectQueuePaper(nextId, { replace: true });
    } else {
      setActivePaperId(null);
    }
  }, [
    activePaperId,
    detailQuery.refresh,
    jobStatusQuery.refresh,
    onSelectPaper,
    paperReportsSummaryQuery.refresh,
    readerListQuery.refresh,
    targetPaperId,
    queueSearchQuery
  ]);

  useEffect(() => {
    if (!readerListQuery.hasData) return;
    const data = readerListQuery.data || {};
    const nextItems = data.items || [];
    const routePaperId = Number(targetPaperId || 0);
    const currentActiveId = Number(activePaperId || 0);
    const pendingRouteId = Number(internalRouteSelectionRef.current || 0);
    const navigatingQueue = queueNavigationRef.current;
    const nextId = resolveReaderQueueSelection({
      activeId: currentActiveId,
      allowRouteOutsideItems: !queueSearchQuery,
      items: nextItems,
      pendingRouteId,
      routePaperId,
      selectFirst: navigatingQueue
    });
    if (navigatingQueue) queueNavigationRef.current = false;
    if (nextId) {
      if (pendingRouteId === nextId && !navigatingQueue) setActivePaperId(Number(nextId));
      else if (!routePaperId || navigatingQueue) selectQueuePaper(nextId, { replace: true });
      else setActivePaperId(Number(nextId));
      return;
    }
    setActivePaperId(null);
  }, [activePaperId, onSelectPaper, queueSearchQuery, readerListQuery.data, readerListQuery.hasData, targetPaperId]);

  useEffect(() => {
    const error = readerListQuery.error || detailQuery.error || paperReportsSummaryQuery.error || jobStatusQuery.error || settingsQuery.error || projectsQuery.error;
    if (error) setStatusMessage(error.message);
  }, [detailQuery.error, jobStatusQuery.error, paperReportsSummaryQuery.error, projectsQuery.error, readerListQuery.error, setStatusMessage, settingsQuery.error]);

  useEffect(() => {
    const numericPaperId = Number(targetPaperId || 0);
    if (!numericPaperId) return;
    if (internalRouteSelectionRef.current === numericPaperId) {
      internalRouteSelectionRef.current = null;
      setActivePaperId(numericPaperId);
      return;
    }
    queueNavigationRef.current = false;
    setQueuePage(0);
    setStatusFilter("all");
    setProjectFilter("all");
    setSourceFilter("all");
    setQueueQuery("");
    setActivePaperId(numericPaperId);
  }, [targetPaperId, targetPaperKey]);

  useEffect(() => {
    if (!targetPaperId || Number(detail?.paper?.id || 0) !== Number(targetPaperId)) return;
    setStatusMessage(t("reader.messages.openedReport"));
  }, [detail?.paper?.id, setStatusMessage, targetPaperId, targetPaperKey]);

  async function generateReport(paperId, force = false) {
    setBusy(true);
    const numericPaperId = Number(paperId);
    try {
      const data = await postJson(`/api/papers/${paperId}/report`, { force });
      if (data?.queued) {
        cache.markStale(["jobs", "summary"]);
        cache.markStale(["jobs", "history"]);
        cache.markStale(cacheNamespace("reader", "papers"));
        cache.markStale(["paper-reports", "summary"]);
        setStatusMessage(t("reader.messages.reportQueued"));
        await refresh();
        return;
      }
      cache.setCache(["reader", "paper", String(numericPaperId)], data);
      cache.markStale(cacheNamespace("reader", "papers"));
      cache.markStale(["paper-reports", "summary"]);
      setStatusMessage(data.paper_report?.status === "done" ? t("reportStatus.done") : reportStatusLabel(data.paper_report?.status, t));
      await refresh();
    } catch (error) {
      setStatusMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function cancelReport(paperId) {
    setBusy(true);
    const numericPaperId = Number(paperId);
    try {
      const data = await postJson(`/api/reader/papers/${paperId}/cancel`, {});
      cache.setCache(["reader", "paper", String(numericPaperId)], data);
      cache.markStale(cacheNamespace("reader", "papers"));
      cache.markStale(["paper-reports", "summary"]);
      setStatusMessage(t("reader.messages.queueCancelled"));
      await refresh();
    } catch (error) {
      setStatusMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function retryReport(paperId) {
    setBusy(true);
    const numericPaperId = Number(paperId);
    try {
      const data = await postJson(`/api/reader/papers/${paperId}/retry`, {});
      cache.setCache(["reader", "paper", String(numericPaperId)], data);
      cache.markStale(cacheNamespace("reader", "papers"));
      cache.markStale(["paper-reports", "summary"]);
      setStatusMessage(t("reader.messages.requeued"));
      await refresh();
    } catch (error) {
      setStatusMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function deleteReport(paperId) {
    const numericPaperId = Number(paperId);
    setDeletingReportId(numericPaperId);
    try {
      await api(`/api/reader/papers/${paperId}/report`, { method: "DELETE" });
      cache.markStale(cacheNamespace("reader", "papers"));
      cache.markStale(["paper-reports", "summary"]);
      cache.markStale(["reader", "paper", String(numericPaperId)]);
      setStatusMessage(t("reader.messages.deletedQueue"));
      await refresh();
    } catch (error) {
      setStatusMessage(error.message);
    } finally {
      setDeletingReportId(null);
    }
  }

  async function linkPaperToProject(paperId, projectId) {
    const numericPaperId = Number(paperId);
    const numericProjectId = Number(projectId);
    if (!numericPaperId || !numericProjectId) return;
    setLinkingProjectPaperId(numericPaperId);
    try {
      const project = projects.find((item) => Number(item.id) === numericProjectId);
      await postJson(`/api/projects/${numericProjectId}/papers`, {
        paper_id: numericPaperId,
        relation: "reading",
        note: "manual_from_report_queue"
      });
      cache.markStale(cacheNamespace("reader", "papers"));
      cache.markStale(["reader", "paper", String(numericPaperId)]);
      cache.markStale(["project", String(numericProjectId)]);
      cache.markStale(["projects"]);
      setStatusMessage(t("reader.messages.projectLinked", { project: project?.name || "" }));
      await refresh();
    } catch (error) {
      setStatusMessage(error.message);
    } finally {
      setLinkingProjectPaperId(null);
    }
  }

  async function sendReaderMessage(rawMessage, options = {}) {
    const paperId = activePaperId;
    if (!paperId || !String(rawMessage || "").trim()) return;
    const nextMessage = String(rawMessage || "").trim();
    const sentAt = Date.now();
    setBusy(true);
    setActiveTab("chat");
    setPendingUser({
      id: `pending-user-${sentAt}`,
      paper_id: paperId,
      role: "user",
      content: nextMessage,
      source: "chat",
      created_at: new Date(sentAt).toISOString(),
      transient: true
    });
    setStreamingAssistant({
      id: `streaming-assistant-${sentAt}`,
      paper_id: paperId,
      role: "assistant",
      content: "",
      source: "chat",
      created_at: new Date().toISOString(),
      transient: true,
      streaming: true
    });
    try {
      const chatPath = `/api/reader/papers/${paperId}/chat`;
      const response = await fetch(chatPath, {
        method: "POST",
        credentials: "same-origin",
        headers: { accept: "text/event-stream", "content-type": "application/json" },
        body: JSON.stringify({
          message: nextMessage,
          stream: true,
          include_project_context: projectContextEnabled
        })
      });
      if (!response.ok) throw await readErrorResponse(response, chatPath, t("reader.chatRequestFailed"));
      let completed = false;
      await readSseStream(response, {
        onStart(data) {
          setStreamingAssistant((current) => current && Number(current.paper_id) === paperId ? {
            ...current,
            model: data.model?.model || current.model,
            model_provider_id: data.model?.provider_id || current.model_provider_id
          } : current);
        },
        onChunk(text) {
          setStreamingAssistant((current) => (
            current && Number(current.paper_id) === paperId
              ? { ...current, content: `${current.content}${text}` }
              : current
          ));
        },
        onDone(data) {
          completed = true;
          if (data.detail) {
            cache.setCache(["reader", "paper", String(paperId)], data.detail);
          }
        }
      });
      if (!completed) {
        await detailQuery.refresh({ force: true });
      }
      setStatusMessage(t("reader.messages.replyGenerated"));
    } catch (error) {
      if (options.restoreOnFailure !== false) setMessage(nextMessage);
      setStatusMessage(error.message);
      await detailQuery.refresh({ force: true }).catch(() => {});
    } finally {
      setPendingUser((current) => current && Number(current.paper_id) === paperId ? null : current);
      setStreamingAssistant((current) => current && Number(current.paper_id) === paperId ? null : current);
      setBusy(false);
    }
  }

  async function changeReaderChatModel(value) {
    const { providerId, model } = parseChatModelValue(value);
    if (!providerId || !model) return;
    setSavingChatModel(true);
    try {
      const data = await postJson("/api/settings", {
        reader_chat_provider_id: providerId,
        reader_chat_model: model
      });
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
      const data = await api(`/api/reader/papers/${paperId}/reference-papers`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paper_ids: paperIds })
      });
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

  async function unlinkPaperFromProject(paperId, projectId) {
    const numericPaperId = Number(paperId);
    const numericProjectId = Number(projectId);
    if (!numericPaperId || !numericProjectId) return;
    setLinkingProjectPaperId(numericPaperId);
    try {
      const project = projects.find((item) => Number(item.id) === numericProjectId);
      await api(`/api/projects/${numericProjectId}/papers/${numericPaperId}`, { method: "DELETE" });
      cache.markStale(cacheNamespace("reader", "papers"));
      cache.markStale(["reader", "paper", String(numericPaperId)]);
      cache.markStale(["project", String(numericProjectId)]);
      cache.markStale(["projects"]);
      setStatusMessage(t("reader.messages.projectUnlinked", { project: project?.name || "" }));
      await refresh();
    } catch (error) {
      setStatusMessage(error.message);
    } finally {
      setLinkingProjectPaperId(null);
    }
  }

  async function savePaperTitle(paperId, title) {
    const numericPaperId = Number(paperId);
    try {
      const data = await api(`/api/reader/papers/${numericPaperId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title })
      });
      cache.setCache(["reader", "paper", String(numericPaperId)], data);
      readerListQuery.patch((current) => ({
        ...(current || {}),
        items: (current?.items || []).map((item) => (
          Number(item.paper_id) === numericPaperId ? { ...item, title } : item
        ))
      }));
      referenceCandidatesQuery.patch((current) => ({
        ...(current || {}),
        items: (current?.items || []).map((item) => (
          Number(item.paper_id) === numericPaperId ? { ...item, title } : item
        ))
      }));
      cache.markStale(cacheNamespace("reader", "papers"));
      Promise.all([
        readerListQuery.refresh({ force: true }),
        detailQuery.refresh({ force: true })
      ]).catch((error) => setStatusMessage(error.message));
      setStatusMessage(t("reader.messages.titleUpdated"));
      return true;
    } catch (error) {
      setStatusMessage(error.message);
      return false;
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
    const paperId = Number(activePaperId);
    setDeletingMessageId(messageId);
    try {
      const data = await api(`/api/reader/papers/${paperId}/messages/${messageId}`, { method: "DELETE" });
      cache.setCache(["reader", "paper", String(paperId)], data);
      setStatusMessage(t("reader.messages.messageDeleted"));
    } catch (error) {
      setStatusMessage(error.message);
    } finally {
      setDeletingMessageId(null);
    }
  }

  async function saveToObsidian(paperId) {
    if (!obsidianCapability.available) {
      setStatusMessage(obsidianCapability.disabledReason);
      return;
    }
    setBusy(true);
    try {
      const data = await postObsidianJson(`/api/reader/papers/${paperId}/save`, {});
      if (data?.queued) {
        cache.markStale(["jobs", "summary"]);
        cache.markStale(["jobs", "history"]);
        setStatusMessage(t("reader.messages.saveQueued"));
        return;
      }
      setStatusMessage(t("reader.messages.savedObsidian", { path: data.obsidian_path || "" }));
    } catch (error) {
      setStatusMessage(friendlyObsidianMessage(error, t));
    } finally {
      setBusy(false);
    }
  }

  async function submitUrls(event) {
    event.preventDefault();
    if (!urls.trim()) return;
    setImportBusy(true);
    try {
      const data = await postJson("/api/reader/papers/urls", { urls });
      if (data?.queued) {
        cache.markStale(["jobs", "summary"]);
        cache.markStale(["jobs", "history"]);
        cache.markStale(cacheNamespace("reader", "papers"));
        setUrls("");
        onClosePaperImport();
        setStatusMessage(t("reader.messages.urlQueued"));
        return;
      }
      cache.markStale(cacheNamespace("reader", "papers"));
      cache.markStale(["paper-reports", "summary"]);
      setUrls("");
      onClosePaperImport();
      setStatusMessage(t("reader.messages.urlComplete", { imported: data.imported?.length || 0, failed: data.errors?.length || 0 }));
      await refresh();
      const firstId = data.imported?.[0]?.paper_id;
      if (firstId) {
        if (onSelectPaper) onSelectPaper(firstId);
        else setActivePaperId(Number(firstId));
      }
    } catch (error) {
      setStatusMessage(error.message);
    } finally {
      setImportBusy(false);
    }
  }

  async function submitWebpages(event) {
    event.preventDefault();
    if (!webUrls.trim()) return;
    setImportBusy(true);
    try {
      const data = await postJson("/api/reader/papers/web", { urls: webUrls });
      if (data?.queued) {
        cache.markStale(["jobs", "summary"]);
        cache.markStale(["jobs", "history"]);
        cache.markStale(cacheNamespace("reader", "papers"));
        setWebUrls("");
        onClosePaperImport();
        setStatusMessage(t("reader.messages.webQueued"));
        return;
      }
      cache.markStale(cacheNamespace("reader", "papers"));
      cache.markStale(["paper-reports", "summary"]);
      setWebUrls("");
      onClosePaperImport();
      setStatusMessage(t("reader.messages.webComplete", { imported: data.imported?.length || 0, failed: data.errors?.length || 0 }));
      await refresh();
      const firstId = data.imported?.[0]?.paper_id;
      if (firstId) {
        if (onSelectPaper) onSelectPaper(firstId);
        else setActivePaperId(Number(firstId));
      }
    } catch (error) {
      setStatusMessage(error.message);
    } finally {
      setImportBusy(false);
    }
  }

  async function submitPdf(event) {
    event.preventDefault();
    if (!selectedFiles.length) return;
    setImportBusy(true);
    try {
      const formData = new FormData();
      for (const file of selectedFiles) {
        formData.append("files", file, file.name);
      }
      const data = await api("/api/reader/papers/upload", { method: "POST", body: formData });
      if (data?.queued) {
        cache.markStale(["jobs", "summary"]);
        cache.markStale(["jobs", "history"]);
        cache.markStale(cacheNamespace("reader", "papers"));
        setSelectedFiles([]);
        onClosePaperImport();
        event.currentTarget.reset();
        setStatusMessage(t("reader.messages.pdfQueued"));
        return;
      }
      cache.markStale(cacheNamespace("reader", "papers"));
      cache.markStale(["paper-reports", "summary"]);
      setSelectedFiles([]);
      onClosePaperImport();
      event.currentTarget.reset();
      setStatusMessage(t("reader.messages.pdfComplete", { imported: data.imported?.length || 0, failed: data.errors?.length || 0 }));
      await refresh();
      const firstId = data.imported?.[0]?.paper_id || data.last_detail?.paper?.id;
      if (firstId) {
        if (data.last_detail) cache.setCache(["reader", "paper", String(firstId)], data.last_detail);
        if (onSelectPaper) onSelectPaper(firstId);
        else setActivePaperId(Number(firstId));
      }
    } catch (error) {
      setStatusMessage(error.message);
    } finally {
      setImportBusy(false);
    }
  }

  return (
    <section className="view report-queue-view reader-view vision-inbox vision-reports">
      <header className="vision-topbar reader-queue-header reports-topbar">
        <div className="vision-brand">
          <span>{t("common.workspace")}</span>
          <h1>{t("reader.title")}</h1>
        </div>
        <div className="vision-top-actions reader-queue-actions">
          <span className={`vision-live-state ${queueStatus.active ? "running" : "ready"}`}>
            <i aria-hidden="true" />
            {queueStatus.enabled ? t("reader.live.auto", { active: queueStatus.active || 0, concurrency: queueStatus.concurrency || 0 }) : t("reader.live.disabled")}
          </span>
          <RefreshButton className="vision-refresh" onClick={() => refresh().catch((error) => setStatusMessage(error.message))} />
          <button className="workspace-primary-action" onClick={onOpenPaperImport} title={t("reader.import.shortcutTitle")} type="button">
            <span aria-hidden="true">＋</span>{t("reader.import.action")}
          </button>
        </div>
      </header>

      <section className="inbox-summary-strip reports-summary-strip" aria-label={t("reader.summary.aria")}>
        <div><span>{t("reader.summary.tasks")}</span><strong>{loading ? "—" : stats.total || items.length}</strong><p>{t("reader.summary.allReports")}</p></div>
        <div><span>{t("reader.summary.processing")}</span><strong>{loading ? "—" : activeReportCount}</strong><p>{t("reader.summary.queuedProcessing")}</p></div>
        <div><span>{t("reader.summary.ready")}</span><strong>{loading ? "—" : stats.done || 0}</strong><p>{t("inbox.summary.deepRead")}</p></div>
      </section>

      <div className="reader-workspace inbox-workspace-grid">
        <section className="inbox-panel report-queue-list-panel" aria-label={t("reader.list.aria")}>
          <header className="inbox-list-heading queue-list-header">
            <div>
              <span>{t("reader.list.eyebrow")}</span>
              <h2>{t("reader.list.title")}</h2>
              <p>{t("reader.list.description")}</p>
            </div>
            <div className="inbox-list-heading-actions">
              <em>{loading || queueSearchPending ? "…" : queueTotal}</em>
              <WorkspacePagination
                compact
                currentPage={queueCurrentPage}
                loading={readerListQuery.status === "loading" || queueSearchPending}
                onNext={() => changeQueuePage(queuePage + 1)}
                onPrevious={() => changeQueuePage(queuePage - 1)}
                pageCount={queuePageCount}
              />
            </div>
          </header>
          <div className="reader-queue-filter-stack">
            <div className="reader-queue-filter-summary">
              <div className="reader-queue-active-filters">
                {queueActiveFilterLabels.length
                  ? queueActiveFilterLabels.map((label) => <span key={label}>{label}</span>)
                  : <span>{t("reader.filters.allReports")}</span>}
              </div>
              <div className="reader-queue-filter-actions">
                {queueActiveFilterCount ? (
                  <button className="filter-clear-button" onClick={clearQueueFilters} type="button">{t("common.clearFilters")}</button>
                ) : null}
                <button
                  aria-controls="reader-queue-filter-panel"
                  aria-expanded={queueFiltersOpen}
                  className="left-filter-toggle"
                  onClick={() => setQueueFiltersOpen((current) => !current)}
                  type="button"
                >
                  {queueFiltersOpen ? t("common.collapseFilters") : t("common.filters", { count: queueActiveFilterCount || "" })}
                </button>
              </div>
            </div>
            <div
              aria-hidden={!queueFiltersOpen}
              className={`reader-queue-filter-collapse ${queueFiltersOpen ? "is-open" : ""}`}
              id="reader-queue-filter-panel"
              inert={!queueFiltersOpen}
            >
              <div className="inbox-list-filters reader-queue-filter-panel" aria-label={t("reader.filters.aria")}>
                <div className="inbox-filter-control reader-queue-status-control">
                  <span>{t("common.status")}</span>
                  <WorkspaceSelect
                    ariaLabel={t("reader.filters.statusAria")}
                    onChange={(value) => changeQueueFilter(setStatusFilter, value)}
                    options={reportFilters}
                    value={statusFilter}
                  />
                </div>
                <div className="inbox-filter-control reader-queue-project-control">
                  <span>{t("reader.filters.project")}</span>
                  <WorkspaceSelect
                    ariaLabel={t("reader.filters.projectAria")}
                    onChange={(value) => changeQueueFilter(setProjectFilter, value)}
                    options={projectFilterOptions}
                    value={projectFilter}
                  />
                </div>
                <div className="inbox-filter-control reader-queue-source-control">
                  <span>{t("common.source")}</span>
                  <WorkspaceSelect
                    ariaLabel={t("library.filters.sourceAria")}
                    onChange={(value) => changeQueueFilter(setSourceFilter, value)}
                    options={sourceFilterOptions}
                    value={sourceFilter}
                  />
                </div>
                <label className="inbox-filter-control inbox-filter-search reader-queue-search-control">
                  <span>{t("common.search")}</span>
                  <input
                    disabled={loading && !items.length}
                    onChange={(event) => setQueueQuery(event.target.value)}
                    placeholder={t("reader.filters.searchPlaceholder")}
                    type="search"
                    value={queueQuery}
                  />
                </label>
              </div>
            </div>
          </div>
          <div className="paper-list inbox-paper-list report-queue-paper-list">
            {loading ? (
              <WorkspacePaneLoader rows={6} title={t("reader.list.loader")} variant="list" />
            ) : visibleItems.length ? visibleItems.map((item) => (
              <ReaderRow
                active={item.paper_id === activePaperId}
                deleting={deletingReportId === item.paper_id}
                item={item}
                key={item.paper_id}
                onDelete={(paperId) => deleteReport(paperId)}
                onSelect={(paperId) => {
                  selectQueuePaper(paperId);
                }}
                recentImport={isRecentManualPaperImport(item, recencyClock)}
              />
            )) : (
              <div className="queue-empty-state">
                <h2>{hasQueueFilters ? t("reader.empty.filteredTitle") : t("reader.empty.queueTitle")}</h2>
                <p>
                  {hasQueueFilters
                    ? t("reader.empty.filteredDescription")
                    : t("reader.empty.queueDescription")}
                </p>
                {hasQueueFilters ? (
                  <button
                    type="button"
                    onClick={clearQueueFilters}
                  >{t("common.clearFilters")}</button>
                ) : <button type="button" onClick={onOpenPaperImport}>{t("reader.import.action")}</button>}
              </div>
            )}
          </div>
          <WorkspacePagination
            currentPage={queueCurrentPage}
            loading={readerListQuery.status === "loading" || queueSearchPending}
            onNext={() => changeQueuePage(queuePage + 1)}
            onPrevious={() => changeQueuePage(queuePage - 1)}
            pageCount={queuePageCount}
          />
        </section>

        <section className="detail-panel inbox-detail-panel reader-detail-panel" aria-label={t("reader.detail.aria")}>
          {loading || detailLoading ? (
            <WorkspacePaneLoader
              description={detailLoading ? t("reader.detail.loadingSelected") : t("reader.detail.loadingDescription")}
              title={detailLoading ? t("reader.detail.opening") : t("reader.detail.loading")}
              variant="report"
            />
          ) : (
            <ReaderDetail
              activeTab={activeTab}
              busy={busy}
              chatSettings={readerSettings}
              deletingMessageId={deletingMessageId}
              detail={detail}
              displayedMessages={displayedMessages}
              key={detail?.paper?.id || "empty"}
              linkingProject={linkingProjectPaperId === detail?.paper?.id}
              message={message}
              obsidianCapability={obsidianCapability}
              onChatModelChange={changeReaderChatModel}
              onCancel={cancelReport}
              onDeleteMessage={deleteMessage}
              onGenerate={generateReport}
              onProjectContextChange={(enabled) => {
                if (!detailPaperId) return;
                setProjectContextPreferences((current) => ({ ...current, [detailPaperId]: enabled }));
              }}
              onProjectLink={linkPaperToProject}
              onProjectUnlink={unlinkPaperFromProject}
              onReferencePapersSave={saveReferencePapers}
              onRetry={retryReport}
              onSave={saveToObsidian}
              onSendQuestion={(question) => sendReaderMessage(question, { restoreOnFailure: false })}
              onSendMessage={sendMessage}
              onTabChange={setActiveTab}
              onTitleSave={savePaperTitle}
              projects={projects}
              projectContextEnabled={projectContextEnabled}
              referenceCandidates={referenceCandidatesQuery.data?.items || items}
              savingChatModel={savingChatModel}
              savingReferencePapers={savingReferencePapers}
              setMessage={setMessage}
            />
          )}
        </section>
      </div>
      <WorkspaceDialog
        className="reader-import-dialog"
        eyebrow={t("reader.importEyebrow")}
        footer={(
          <div>
            <button disabled={importBusy} onClick={onClosePaperImport} type="button">{t("common.close")}</button>
          </div>
        )}
        icon="IN"
        onClose={() => { if (!importBusy) onClosePaperImport(); }}
        open={importOpen}
        title={t("reader.import.title")}
      >
        <div className="reader-import-dialog-body">
          <form className="reader-import-method" onSubmit={submitUrls}>
            <header>
              <i aria-hidden="true">URL</i>
              <div><span>{t("reader.import.pdfLinks")}</span><h3>{t("reader.import.fromLinks")}</h3></div>
            </header>
            <label className="workspace-field">
              <span>{t("reader.importUrlLabel")}</span>
              <textarea
                disabled={importBusy}
                onChange={(event) => setUrls(event.target.value)}
                placeholder={"https://arxiv.org/abs/2401.00001\nhttps://arxiv.org/abs/2401.00002"}
                value={urls}
              />
            </label>
            <button className="reader-import-submit" disabled={importBusy || !urls.trim()} type="submit">
              {importBusy ? <InlineLoader compact label={t("reader.import.importing")} /> : <>{t("reader.import.findPdf")} <i aria-hidden="true">→</i></>}
            </button>
          </form>
          <form className="reader-import-method" onSubmit={submitPdf}>
            <header>
              <i aria-hidden="true">PDF</i>
              <div><span>{t("reader.import.localFiles")}</span><h3>{t("reader.import.uploadPdf")}</h3></div>
            </header>
            <label className="reader-import-file-picker">
              <input
                accept="application/pdf,.pdf"
                disabled={importBusy}
                multiple
                onChange={(event) => setSelectedFiles([...event.target.files || []])}
                type="file"
              />
              <i aria-hidden="true">＋</i>
              <span>
                <strong>{selectedFiles.length ? t("reader.import.selectedPdf", { count: selectedFiles.length }) : t("reader.import.selectPdf")}</strong>
                <small>{selectedFiles.length ? selectedFiles.map((file) => file.name).join(t("common.listSeparator")) : t("reader.import.pdfHint")}</small>
              </span>
            </label>
            <button className="reader-import-submit" disabled={importBusy || !selectedFiles.length} type="submit">
              {importBusy ? <InlineLoader compact label={t("reader.import.importing")} /> : <>{t("reader.import.importPdf", { count: selectedFiles.length || "" })} <i aria-hidden="true">→</i></>}
            </button>
          </form>
          <form className="reader-import-method is-webpage" onSubmit={submitWebpages}>
            <header>
              <i aria-hidden="true">WEB</i>
              <div><span>{t("reader.import.webText")}</span><h3>{t("reader.import.extractWeb")}</h3></div>
            </header>
            <label className="workspace-field">
              <span>{t("reader.import.webUrls")}</span>
              <textarea
                disabled={importBusy}
                onChange={(event) => setWebUrls(event.target.value)}
                placeholder={"https://example.com/article\nhttps://example.org/blog/post"}
                value={webUrls}
              />
            </label>
            <button className="reader-import-submit" disabled={importBusy || !webUrls.trim()} type="submit">
              {importBusy ? <InlineLoader compact label={t("reader.import.extracting")} /> : <>{t("reader.import.extractAction")} <i aria-hidden="true">→</i></>}
            </button>
          </form>
        </div>
      </WorkspaceDialog>
    </section>
  );
}
