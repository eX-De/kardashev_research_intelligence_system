import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatNotification } from "../lib/systemMessages.js";
import "../styles/ToastHost.css";

const TOAST_EXIT_DURATION = 180;

function translatedMessage(commonT, systemT, message) {
  if (message?.kind === "system-notification" && message.notification) {
    const translated = formatNotification(message.notification, systemT);
    return [translated.title, translated.detail]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .join(commonT("messageSeparator"));
  }
  if (!message || typeof message !== "object" || typeof message.key !== "string") {
    return String(message ?? "");
  }
  return commonT(message.key, {
    ...(message.values || {}),
    defaultValue: message.fallback,
    ns: message.namespace
  });
}

function ToastItem({ toast, onDismiss }) {
  const { t: commonT } = useTranslation("common");
  const { t: systemT } = useTranslation("system");
  const [exiting, setExiting] = useState(false);
  const exitTimerRef = useRef(null);

  const beginDismiss = useCallback(() => {
    if (exitTimerRef.current) return;
    setExiting(true);
    exitTimerRef.current = window.setTimeout(() => onDismiss(toast.id), TOAST_EXIT_DURATION);
  }, [onDismiss, toast.id]);

  useEffect(() => {
    if (!toast.duration) return undefined;
    const timer = window.setTimeout(beginDismiss, toast.duration);
    return () => window.clearTimeout(timer);
  }, [beginDismiss, toast.duration]);

  useEffect(() => () => {
    if (exitTimerRef.current) window.clearTimeout(exitTimerRef.current);
  }, []);

  const label = commonT(`toast.${toast.type || "info"}`);

  return (
    <article className={`toast ${toast.type} ${exiting ? "is-exiting" : ""}`} role={toast.type === "error" ? "alert" : "status"}>
      <div className="toast-content">
        <span className="toast-label">{label}</span>
        <p className="toast-message">{translatedMessage(commonT, systemT, toast.message)}</p>
      </div>
      <button
        aria-label={commonT("actions.closeNotification")}
        className="toast-dismiss"
        onClick={beginDismiss}
        title={commonT("actions.close")}
        type="button"
      >
        ×
      </button>
    </article>
  );
}

export function ToastHost({ toasts, onDismiss }) {
  const { t } = useTranslation("common");
  if (!toasts.length) return null;

  return (
    <section aria-label={t("toast.host")} className="toast-host">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} onDismiss={onDismiss} toast={toast} />
      ))}
    </section>
  );
}
