import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
import { LazyMarkdownReport } from "./LazyMarkdownReport.jsx";
import { RefreshButton } from "./RefreshButton.jsx";
import { InlineLoader, LoadingPanel } from "./Loading.jsx";

const REPORT_STATUS_LABELS = {
  queued: "排队",
  processing: "生成中",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消"
};

const REPORT_FILTERS = [
  ["all", "全部"],
  ["queued", "排队"],
  ["processing", "生成中"],
  ["done", "已完成"],
  ["failed", "失败"],
  ["cancelled", "已取消"]
];

function reportStatusLabel(status) {
  return REPORT_STATUS_LABELS[status] || status || "Missing";
}

function useDebouncedValue(value, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
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

async function readErrorResponse(response, path) {
  const data = await readResponseJson(response);
  const error = createApiError(response, data, "阅读器对话请求失败。");
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

function ReaderRow({ active, deleting, item, onDelete, onSelect }) {
  const canDelete = item.status !== "processing";
  const linkedProjectNames = item.linked_project_names || [];
  const recommendationProjectNames = item.recommendation_project_names || [];
  const projectNames = linkedProjectNames.length ? linkedProjectNames : recommendationProjectNames;
  const projectCount = linkedProjectNames.length ? item.linked_project_count : item.recommendation_project_count;
  return (
    <article className={`report-row ${active ? "active" : ""}`} onClick={() => onSelect(item.paper_id)} role="button" tabIndex={0}>
      <div className="report-row-main">
        <div className="report-row-title">{item.title}</div>
        <div className="report-row-meta">
          <span>{item.arxiv_id}</span>
          <span>TXT {item.text_status || "pending"}</span>
          {projectNames.length ? <span>{linkedProjectNames.length ? "已关联" : "推荐"} {projectNames.slice(0, 2).join(", ")}</span> : null}
          {projectCount > 2 ? <span>{projectCount} 个项目</span> : null}
          {item.model ? <span>{item.model}</span> : null}
          {item.updated_at ? <span>{fmtDate(item.updated_at)}</span> : null}
        </div>
        {item.error_message ? <p className="report-row-error">{item.error_message}</p> : null}
      </div>
      <div className="report-row-actions">
        <span className={`status-pill report-status-${item.status}`}>{reportStatusLabel(item.status)}</span>
        <button
          className={`danger queue-delete-button ${deleting ? "is-busy" : ""}`}
          disabled={!canDelete || deleting}
          onClick={(event) => {
            event.stopPropagation();
            onDelete(item.paper_id);
          }}
          title={canDelete ? "从报告队列删除" : "生成中的报告不能删除"}
          type="button"
        >
          {deleting ? <InlineLoader compact label="删除中" /> : "删除"}
        </button>
      </div>
    </article>
  );
}

function messageSourceLabel(source) {
  if (source === "analysis_prompt") return "报告用 Prompt";
  if (source === "analysis_report") return "全文报告";
  if (source === "chat") return "Chat";
  return source || "";
}

function ChatMessage({ deleting, message, onDelete }) {
  const isAssistant = message.role === "assistant";
  const numericId = Number(message.id);
  const persistedId = Number.isInteger(numericId) ? numericId : null;
  const isAnalysisSeed = ["analysis_prompt", "analysis_report"].includes(message.source);
  const canDelete = persistedId && persistedId > 0 && message.source === "chat" && onDelete;
  const roleLabel = isAssistant ? "Assistant" : "You";
  const sourceLabel = messageSourceLabel(message.source);
  return (
    <article
      className={`reader-message ${isAssistant ? "assistant" : "user"} ${isAnalysisSeed ? "analysis-seed" : ""} ${message.transient ? "transient" : ""}`}
      data-message-id={persistedId ?? undefined}
      data-reader-message={persistedId ? "true" : undefined}
    >
      <div className="reader-message-header">
        <strong>{roleLabel}</strong>
        {sourceLabel ? <span>{sourceLabel}</span> : null}
        {message.model ? <span>{message.model}</span> : null}
        {message.created_at ? <span>{fmtDate(message.created_at)}</span> : null}
        {message.streaming ? <span>streaming</span> : null}
        {message.context?.reference_paper_ids?.length ? (
          <span>参考论文 {message.context.reference_paper_ids.length}</span>
        ) : null}
        {canDelete ? (
          <button disabled={deleting} onClick={() => onDelete(persistedId)} type="button">
            {deleting ? "删除中" : "删除"}
          </button>
        ) : null}
      </div>
      <div data-message-content="true">
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
  const linkedProjectIds = new Set((linkedProjects || []).map((item) => Number(item.project_id)));
  const linkedProjectNames = (linkedProjects || []).map((item) => item.project_name).filter(Boolean);
  const label = !projects.length ? "暂无项目" : linking ? "关联中..." : "手动关联到项目";
  return (
    <div className="project-link-control">
      <select
        aria-label="手动关联项目"
        className="project-link-select"
        disabled={!projects.length || linking}
        onChange={(event) => onLink(paperId, event.target.value)}
        title="手动关联到项目"
        value=""
      >
        <option value="">{label}</option>
        {projects.map((project) => (
          <option disabled={linkedProjectIds.has(Number(project.id))} key={project.id} value={project.id}>
            {linkedProjectIds.has(Number(project.id)) ? `已关联 ${project.name}` : project.name}
          </option>
        ))}
      </select>
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
  onReferencePapersSave,
  onRetry,
  onSave,
  onSendMessage,
  onSendQuestion,
  onTabChange,
  projects,
  projectContextEnabled,
  referenceCandidates,
  savingReferencePapers,
  savingChatModel,
  setMessage
}) {
  const [selectedText, setSelectedText] = useState("");
  const [selectionContext, setSelectionContext] = useState(null);
  const [questionSuggestions, setQuestionSuggestions] = useState([]);
  const [questionError, setQuestionError] = useState("");
  const [generatingQuestions, setGeneratingQuestions] = useState(false);
  const [followUpPanelPosition, setFollowUpPanelPosition] = useState(null);
  const [referenceDialogOpen, setReferenceDialogOpen] = useState(false);
  const [referenceQuery, setReferenceQuery] = useState("");
  const [draftReferenceIds, setDraftReferenceIds] = useState([]);
  const messagesRef = useRef(null);

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

  if (!detail?.paper) {
    return (
      <div className="empty-detail">
        <h2>选择一篇论文</h2>
        <p>解读报告和逐篇对话会显示在这里。</p>
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
  const obsidianHint = obsidianCapability?.disabledReason || "请先配置可选 Obsidian 集成。";
  const selectedChatModelValue = chatModelOptions.some((option) => option.value === chatModelValue)
    ? chatModelValue
    : "";

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
    <div className="detail-card reader-detail-card">
      <div className="detail-main">
        <div className="detail-title">
          <h2>{paper.title}</h2>
          <p className="muted">
            <a href={paper.link} target="_blank" rel="noreferrer">{paper.arxiv_id}</a>
            {" · "}
            {(paper.categories || []).join(", ") || "arXiv"}
          </p>
          <p className="muted">TXT: {paper.text_status || "pending"}{paper.text_path ? ` · ${paper.text_path}` : ""}</p>
          {paper.pdf_path ? (
            <p className="muted">
              <a href={`/api/reader/papers/${paper.id}/pdf`} target="_blank" rel="noreferrer">打开 PDF</a>
              {" · "}
              {paper.pdf_path}
            </p>
          ) : null}
        </div>

        <div className="reader-tabs" role="tablist">
          <button className={activeTab === "analysis" ? "active" : ""} onClick={() => onTabChange("analysis")} type="button">
            解读报告
          </button>
          <button className={activeTab === "chat" ? "active" : ""} onClick={() => onTabChange("chat")} type="button">
            Chat
          </button>
          <button className={activeTab === "meta" ? "active" : ""} onClick={() => onTabChange("meta")} type="button">
            元信息
          </button>
        </div>

        {activeTab === "analysis" ? (
          <>
            <div className="reader-action-strip">
              <div className={`report-state ${report.status || "missing"}`}>
                <strong>{reportStatusLabel(report.status)}</strong>
                {report.error_message ? <p>{report.error_message}</p> : null}
                {report.model ? <p>{report.model_provider_id ? `${report.model_provider_id} · ` : ""}{report.model}</p> : null}
                {report.updated_at ? <p>Updated: {fmtDate(report.updated_at)}</p> : null}
              </div>
              <div className="detail-actions">
                <button
                  aria-label="智能保存到 Obsidian"
                  disabled={smartSaveDisabled}
                  onClick={() => onSave(paper.id)}
                  title={obsidianCapability?.available ? "用全文报告和 Chat 对话整理成 Obsidian 笔记" : obsidianHint}
                  type="button"
                >
                  智能保存
                </button>
                {!obsidianCapability?.available ? <p className="capability-hint">{obsidianHint}</p> : null}
                {report.status !== "processing" && report.status !== "queued" && !ready ? (
                  <button disabled={busy} onClick={() => onGenerate(paper.id, false)} type="button">生成全文报告</button>
                ) : null}
                {report.status === "queued" ? (
                  <button disabled={busy} onClick={() => onCancel(paper.id)} type="button">取消排队</button>
                ) : null}
                {canRetry ? (
                  <button disabled={busy} onClick={() => onRetry(paper.id)} type="button">重新入队</button>
                ) : null}
              </div>
            </div>
            <div className="section">
              <h3>项目关联</h3>
              <ProjectLinkControl
                linkedProjects={linkedProjects}
                linking={linkingProject}
                onLink={onProjectLink}
                paperId={paper.id}
                projects={projects}
              />
              <div className="evidence-list">
                {linkedProjects.map((project) => (
                  <article className="evidence" key={`linked-${project.project_id}`}>
                    <strong>{project.project_name} · {project.relation} · 已关联</strong>
                    <p>{project.note || "手动关联到项目。"}</p>
                  </article>
                ))}
                {recommendations.map((recommendation) => (
                  <article className="evidence" key={`${recommendation.project_id}-${recommendation.state}`}>
                    <strong>{recommendation.project_name} · {recommendation.relation_type} · {recommendation.state}</strong>
                    <p>{recommendation.reason || "暂无推荐理由。"}</p>
                  </article>
                ))}
                {!linkedProjects.length && !recommendations.length ? <p className="summary">暂无项目级推荐。</p> : null}
              </div>
            </div>
            <div className="section">
              <h3>全文报告</h3>
              {ready ? <LazyMarkdownReport markdown={report.report_markdown} /> : <p className="muted">报告尚未生成。</p>}
            </div>
          </>
        ) : null}

        {activeTab === "chat" ? (
          <section className="reader-chat">
            <div className="reader-messages" onKeyUp={updateSelectedText} onMouseUp={updateSelectedText} ref={messagesRef}>
              {displayedMessages.length ? displayedMessages.map((item) => (
                <ChatMessage
                  deleting={deletingMessageId === Number(item.id)}
                  key={item.id}
                  message={item}
                  onDelete={onDeleteMessage}
                />
              )) : <p className="muted">还没有对话。发送问题后会基于论文全文回答。</p>}
            </div>
            {selectedText && followUpPanelPosition ? (
              <div
                className="reader-followups reader-followups-floating"
                onMouseDown={(event) => event.preventDefault()}
                style={{
                  left: `${followUpPanelPosition.left}px`,
                  top: `${followUpPanelPosition.top}px`,
                  width: `${followUpPanelPosition.width}px`
                }}
              >
                <div className="reader-followups-header">
                  <strong>追问建议</strong>
                  <button onClick={clearSelection} type="button">清除</button>
                </div>
                <p>{selectedText.length > 260 ? `${selectedText.slice(0, 260)}...` : selectedText}</p>
                <div className="reader-followups-actions">
                  <button disabled={generatingQuestions || busy} onClick={generateQuestions} type="button">
                    {generatingQuestions ? <InlineLoader compact label="生成中" /> : "生成追问"}
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
            ) : null}
            <div className="reader-chat-composer">
              <div className="reader-chat-toolbar">
                <label className="reader-chat-model-control">
                  <span>Chat 模型</span>
                  <select
                    disabled={!chatSettings || !chatModelOptions.length || savingChatModel || busy}
                    onChange={(event) => onChatModelChange(event.target.value)}
                    value={selectedChatModelValue}
                  >
                    {chatModelOptions.length ? (
                      <>
                        <option value="">选择 Chat 模型</option>
                        {chatModelOptions.map((option) => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </>
                    ) : <option value="">未配置模型</option>}
                  </select>
                </label>
                <label
                  className={`reader-project-context-control ${hasProjectContext ? "" : "is-disabled"}`}
                  title={hasProjectContext
                    ? `注入正式关联以及 pending/accepted 推荐项目：${contextProjectNames.join("、")}`
                    : "当前论文没有正式关联或 pending/accepted 推荐项目"}
                >
                  <input
                    checked={hasProjectContext && projectContextEnabled}
                    disabled={!hasProjectContext || busy}
                    onChange={(event) => onProjectContextChange(event.target.checked)}
                    type="checkbox"
                  />
                  <span>
                    使用项目上下文
                    <small>{hasProjectContext ? `${contextProjectNames.length} 个项目` : "没有项目"}</small>
                  </span>
                </label>
                <button className="reader-reference-button" onClick={openReferenceDialog} type="button">
                  添加参考论文
                </button>
              </div>
              {referencePapers.length ? (
                <div className="reader-reference-tags">
                  <span>参考论文</span>
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
                      title="移除参考论文"
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
                  placeholder="针对这篇论文提问..."
                  value={message}
                />
                <button className={busy ? "is-busy" : undefined} disabled={busy || !message.trim()} type="submit">
                  {busy ? <InlineLoader compact label="发送中" /> : "发送"}
                </button>
              </form>
              {referenceDialogOpen ? (
                <div className="modal-backdrop" role="presentation">
                  <article aria-modal="true" className="modal-dialog reader-reference-dialog" role="dialog">
                    <header className="modal-header">
                      <div>
                        <h2>参考论文上下文</h2>
                        <p>选择最多 3 篇全文可用论文；发送问题时会注入完整 TXT。</p>
                      </div>
                      <button className="modal-close" onClick={() => setReferenceDialogOpen(false)} type="button">×</button>
                    </header>
                    <div className="modal-body reader-reference-body">
                      <input
                        autoFocus
                        onChange={(event) => setReferenceQuery(event.target.value)}
                        placeholder="搜索标题或 arXiv ID"
                        type="search"
                        value={referenceQuery}
                      />
                      <p className="muted">已选择 {draftReferenceIds.length}/3</p>
                      <div className="reader-reference-list">
                        {visibleReferenceCandidates.length ? visibleReferenceCandidates.map((candidate) => {
                          const candidateId = Number(candidate.paper_id);
                          const selected = draftReferenceIds.includes(candidateId);
                          const available = candidate.text_status === "complete";
                          return (
                            <label className={!available ? "is-disabled" : ""} key={candidateId}>
                              <input
                                checked={selected}
                                disabled={!available || (!selected && draftReferenceIds.length >= 3)}
                                onChange={() => toggleReferencePaper(candidateId)}
                                type="checkbox"
                              />
                              <span>
                                <strong>{candidate.title || "未命名论文"}</strong>
                                <small>{candidate.arxiv_id || `Paper ${candidateId}`} · {available ? "全文可用" : "尚未提取全文"}</small>
                              </span>
                            </label>
                          );
                        }) : <p className="muted">没有匹配的论文。</p>}
                      </div>
                    </div>
                    <div className="modal-actions">
                      <button onClick={() => setReferenceDialogOpen(false)} type="button">取消</button>
                      <button className="primary" disabled={savingReferencePapers} onClick={saveReferencePapers} type="button">
                        {savingReferencePapers ? "保存中..." : "完成"}
                      </button>
                    </div>
                  </article>
                </div>
              ) : null}
            </div>
          </section>
        ) : null}

        {activeTab === "meta" ? (
          <section className="reader-meta-grid">
            <div className="reader-meta-item wide">
              <span>标题</span>
              <strong>{paper.title || "未记录"}</strong>
            </div>
            <div className="reader-meta-item">
              <span>arXiv</span>
              <strong>{paper.arxiv_id || "未记录"}</strong>
            </div>
            <div className="reader-meta-item">
              <span>分类</span>
              <strong>{(paper.categories || []).join(", ") || "未记录"}</strong>
            </div>
            <div className="reader-meta-item">
              <span>TXT 状态</span>
              <strong>{paper.text_status || "pending"}</strong>
            </div>
            <div className="reader-meta-item">
              <span>PDF</span>
              <strong>{paper.pdf_path ? "已缓存" : "未缓存"}</strong>
            </div>
            <div className="reader-meta-item wide">
              <span>作者</span>
              <strong>{(paper.authors || []).join(", ") || "未记录"}</strong>
            </div>
            <div className="reader-meta-item wide">
              <span>TXT 路径</span>
              <strong>{paper.text_path || "未生成"}</strong>
            </div>
            <div className="reader-meta-item wide">
              <span>PDF 路径</span>
              <strong>{paper.pdf_path || "未缓存"}</strong>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

export function ReaderView({ onSelectPaper, setStatusMessage, targetPaperId, targetPaperKey }) {
  const cache = useApiCacheClient();
  const [activePaperId, setActivePaperId] = useState(null);
  const [activeTab, setActiveTab] = useState("analysis");
  const [message, setMessage] = useState("");
  const [urls, setUrls] = useState("");
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState("all");
  const [queueQuery, setQueueQuery] = useState("");
  const [queueFiltersOpen, setQueueFiltersOpen] = useState(false);
  const [pendingUser, setPendingUser] = useState(null);
  const [streamingAssistant, setStreamingAssistant] = useState(null);
  const [deletingMessageId, setDeletingMessageId] = useState(null);
  const [deletingReportId, setDeletingReportId] = useState(null);
  const [linkingProjectPaperId, setLinkingProjectPaperId] = useState(null);
  const [savingChatModel, setSavingChatModel] = useState(false);
  const [projectContextPreferences, setProjectContextPreferences] = useState({});
  const [savingReferencePapers, setSavingReferencePapers] = useState(false);
  const debouncedQueueQuery = useDebouncedValue(queueQuery);
  const queueSearchQuery = debouncedQueueQuery.trim();
  const readerListQueryString = useMemo(() => {
    const params = new URLSearchParams({ limit: "300" });
    if (queueSearchQuery) params.set("q", queueSearchQuery);
    return params.toString();
  }, [queueSearchQuery]);
  const readerListQuery = useCachedApi(
    ["reader", "papers", readerListQueryString],
    () => api(`/api/reader/papers?${readerListQueryString}`),
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
  const visibleItems = useMemo(() => (
    statusFilter === "all" ? items : items.filter((item) => item.status === statusFilter)
  ), [items, statusFilter]);
  const hasQueueSearch = Boolean(queueSearchQuery);
  const queueSearchPending = queueQuery.trim() !== queueSearchQuery;
  const queueActiveFilterCount = queueQuery.trim() ? 1 : 0;

  const refresh = useCallback(async () => {
    const [data] = await Promise.all([
      readerListQuery.refresh({ force: true }),
      jobStatusQuery.refresh({ force: true }),
      paperReportsSummaryQuery.refresh({ force: true }),
      activePaperId ? detailQuery.refresh({ force: true }) : Promise.resolve(null)
    ]);
    const nextItems = data.items || [];
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
      onSelectPaper?.(nextId, { replace: true });
      setActivePaperId(Number(nextId));
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
    const activeStillExists = currentActiveId && nextItems.some((item) => item.paper_id === currentActiveId);
    const routePaperVisible = routePaperId && nextItems.some((item) => item.paper_id === routePaperId);
    const nextId = routePaperId && (!queueSearchQuery || routePaperVisible)
      ? routePaperId
      : (activeStillExists ? currentActiveId : nextItems[0]?.paper_id);
    if (nextId) {
      if (!routePaperId) onSelectPaper?.(nextId, { replace: true });
      setActivePaperId(Number(nextId));
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
    setStatusFilter("all");
    setActivePaperId(numericPaperId);
  }, [targetPaperId, targetPaperKey]);

  useEffect(() => {
    if (!targetPaperId || Number(detail?.paper?.id || 0) !== Number(targetPaperId)) return;
    setStatusMessage("已打开对应全文报告");
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
        setStatusMessage("全文报告已加入生成队列");
        await refresh();
        return;
      }
      cache.setCache(["reader", "paper", String(numericPaperId)], data);
      cache.markStale(cacheNamespace("reader", "papers"));
      cache.markStale(["paper-reports", "summary"]);
      setStatusMessage(data.paper_report?.status === "done" ? "全文报告已生成" : reportStatusLabel(data.paper_report?.status));
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
      setStatusMessage("报告排队已取消");
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
      setStatusMessage("报告已重新加入队列");
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
      setStatusMessage("已从报告队列删除");
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
      setStatusMessage(`已关联到项目${project?.name ? `：${project.name}` : ""}`);
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
      if (!response.ok) throw await readErrorResponse(response, chatPath);
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
      setStatusMessage("阅读器回复已生成");
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
      setStatusMessage(`Chat 模型已切换：${model}`);
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
      setStatusMessage("参考论文上下文已更新，将从下一条消息开始生效");
      return true;
    } catch (error) {
      setStatusMessage(error.message);
      return false;
    } finally {
      setSavingReferencePapers(false);
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
      setStatusMessage("消息已删除");
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
        setStatusMessage("保存任务已加入队列");
        return;
      }
      setStatusMessage(`已保存到 Obsidian：${data.obsidian_path || ""}`);
    } catch (error) {
      setStatusMessage(friendlyObsidianMessage(error));
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
        setImportOpen(false);
        setStatusMessage("URL 导入已加入队列");
        return;
      }
      cache.markStale(cacheNamespace("reader", "papers"));
      cache.markStale(["paper-reports", "summary"]);
      setUrls("");
      setImportOpen(false);
      setStatusMessage(`URL 导入完成：${data.imported?.length || 0} 篇，失败 ${data.errors?.length || 0} 篇`);
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
        setImportOpen(false);
        event.currentTarget.reset();
        setStatusMessage("PDF 导入已加入队列");
        return;
      }
      cache.markStale(cacheNamespace("reader", "papers"));
      cache.markStale(["paper-reports", "summary"]);
      setSelectedFiles([]);
      setImportOpen(false);
      event.currentTarget.reset();
      setStatusMessage(`PDF 导入完成：${data.imported?.length || 0} 篇，失败 ${data.errors?.length || 0} 篇`);
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
    <section className="view report-queue-view reader-view">
      <header className="reader-queue-header">
        <div>
          <h1>报告队列</h1>
          <p className="muted">
            自动生成{queueStatus.enabled ? "已启用" : "未启用"}
            {queueStatus.concurrency ? ` · 并发 ${queueStatus.active || 0}/${queueStatus.concurrency}` : ""}
            {queueStatus.last_skip_reason ? ` · ${queueStatus.last_skip_reason}` : ""}
          </p>
        </div>
        <div className="reader-queue-actions">
          <button onClick={() => setImportOpen((current) => !current)} type="button">
            {importOpen ? "收起导入" : "导入论文"}
          </button>
          <RefreshButton onClick={() => refresh().catch((error) => setStatusMessage(error.message))} />
        </div>
      </header>

      <div className="reader-queue-filters" role="tablist" aria-label="报告状态筛选">
        {REPORT_FILTERS.map(([status, label]) => (
          <button className={statusFilter === status ? "active" : ""} key={status} onClick={() => setStatusFilter(status)} type="button">
            <span>{label}</span>
            <strong>{status === "all" ? stats.total || items.length : stats[status] || 0}</strong>
          </button>
        ))}
      </div>

      {importOpen ? (
        <div className="reader-import-drawer">
          <form className="reader-import-block" onSubmit={submitUrls}>
            <label>
              <span>导入 arXiv URL</span>
              <textarea
                disabled={importBusy}
                onChange={(event) => setUrls(event.target.value)}
                placeholder="https://arxiv.org/abs/..."
                value={urls}
              />
            </label>
            <button className={importBusy ? "is-busy" : undefined} disabled={importBusy || !urls.trim()} type="submit">
              {importBusy ? <InlineLoader compact label="导入中" /> : "导入 URL"}
            </button>
          </form>
          <form className="reader-import-block" onSubmit={submitPdf}>
            <label>
              <span>导入本地 PDF</span>
              <input
                accept="application/pdf,.pdf"
                disabled={importBusy}
                multiple
                onChange={(event) => setSelectedFiles([...event.target.files || []])}
                type="file"
              />
            </label>
            <button className={importBusy ? "is-busy" : undefined} disabled={importBusy || !selectedFiles.length} type="submit">
              {importBusy ? <InlineLoader compact label="导入中" /> : `导入 PDF${selectedFiles.length ? ` (${selectedFiles.length})` : ""}`}
            </button>
          </form>
        </div>
      ) : null}

      <div className="reader-workspace">
        <section className="report-list-panel" aria-label="全文报告队列">
          <header className="queue-list-header">
            <div>
              <h2>队列列表</h2>
              <p className="muted">
                {loading || queueSearchPending
                  ? "读取中"
                  : `${visibleItems.length} / ${items.length} 篇${hasQueueSearch ? "匹配" : ""}`}
              </p>
            </div>
            <div className="paper-filter-summary reader-queue-filter-summary">
              <button
                aria-controls="reader-queue-filter-panel"
                aria-expanded={queueFiltersOpen}
                className="left-filter-toggle"
                onClick={() => setQueueFiltersOpen((current) => !current)}
                type="button"
              >
                {queueFiltersOpen ? "收起筛选" : `筛选${queueActiveFilterCount ? ` (${queueActiveFilterCount})` : ""}`}
              </button>
            </div>
          </header>
          {queueFiltersOpen ? (
            <div className="library-toolbar paper-library-toolbar reader-queue-filter-panel" id="reader-queue-filter-panel" aria-label="报告队列筛选">
              <label className="library-filter-control paper-filter-control paper-search-control reader-queue-search-control">
                <span>搜索</span>
                <input
                  disabled={loading && !items.length}
                  onChange={(event) => setQueueQuery(event.target.value)}
                  placeholder="标题、arXiv、正文或状态"
                  type="search"
                  value={queueQuery}
                />
              </label>
            </div>
          ) : null}
          <div className="report-list">
            {loading ? (
              <LoadingPanel compact rows={8} title="读取队列列表" />
            ) : visibleItems.length ? visibleItems.map((item) => (
              <ReaderRow
                active={item.paper_id === activePaperId}
                deleting={deletingReportId === item.paper_id}
                item={item}
                key={item.paper_id}
                onDelete={(paperId) => deleteReport(paperId)}
                onSelect={(paperId) => {
                  if (onSelectPaper) {
                    onSelectPaper(paperId);
                    return;
                  }
                  setActivePaperId(Number(paperId));
                }}
              />
            )) : (
              <div className="queue-empty-state">
                <h2>{items.length ? "当前筛选下没有任务" : hasQueueSearch ? "没有匹配的报告" : "暂无全文报告任务"}</h2>
                <p>
                  {items.length
                    ? "切换状态筛选查看其它报告。"
                    : hasQueueSearch
                      ? "换一个关键词或清空搜索。"
                      : "项目级推荐通过后会自动进入这里，也可以导入 URL 或 PDF。"}
                </p>
                {!items.length && hasQueueSearch ? <button type="button" onClick={() => setQueueQuery("")}>清空搜索</button> : null}
                {!items.length && !hasQueueSearch ? <button type="button" onClick={() => setImportOpen(true)}>导入论文</button> : null}
              </div>
            )}
          </div>
        </section>

        <section className="detail-panel" aria-label="报告队列详情">
          {loading || detailLoading ? (
            <LoadingPanel
              description={detailLoading ? "正在读取所选论文的报告、Chat 记录和项目关联。" : "正在读取报告详情、阅读设置和项目关联。"}
              rows={8}
              title={detailLoading ? "打开报告详情" : "读取报告详情"}
            />
          ) : (
            <ReaderDetail
              activeTab={activeTab}
              busy={busy}
              chatSettings={readerSettings}
              deletingMessageId={deletingMessageId}
              detail={detail}
              displayedMessages={displayedMessages}
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
              onReferencePapersSave={saveReferencePapers}
              onRetry={retryReport}
              onSave={saveToObsidian}
              onSendQuestion={(question) => sendReaderMessage(question, { restoreOnFailure: false })}
              onSendMessage={sendMessage}
              onTabChange={setActiveTab}
              projects={projects}
              projectContextEnabled={projectContextEnabled}
              referenceCandidates={items}
              savingChatModel={savingChatModel}
              savingReferencePapers={savingReferencePapers}
              setMessage={setMessage}
            />
          )}
        </section>
      </div>
    </section>
  );
}
