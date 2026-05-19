import { useEffect } from "react";

const TOAST_LABELS = {
  error: "错误",
  info: "提示",
  success: "成功",
  warning: "警告"
};

function ToastItem({ toast, onDismiss }) {
  useEffect(() => {
    if (!toast.duration) return undefined;
    const timer = window.setTimeout(() => onDismiss(toast.id), toast.duration);
    return () => window.clearTimeout(timer);
  }, [onDismiss, toast.duration, toast.id]);

  const label = TOAST_LABELS[toast.type] || TOAST_LABELS.info;

  return (
    <article className={`toast ${toast.type}`} role={toast.type === "error" ? "alert" : "status"}>
      <div className="toast-content">
        <span className="toast-label">{label}</span>
        <p className="toast-message">{toast.message}</p>
      </div>
      <button
        aria-label="关闭通知"
        className="toast-dismiss"
        onClick={() => onDismiss(toast.id)}
        title="关闭"
        type="button"
      >
        ×
      </button>
    </article>
  );
}

export function ToastHost({ toasts, onDismiss }) {
  if (!toasts.length) return null;

  return (
    <section aria-label="通知" className="toast-host">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} onDismiss={onDismiss} toast={toast} />
      ))}
    </section>
  );
}
