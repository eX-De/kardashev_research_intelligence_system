import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import "../styles/WorkspaceDialog.css";

const DIALOG_EXIT_MS = 220;

export function WorkspaceDialog({ children, className = "", description, eyebrow, footer, icon = "WS", onClose, open, title }) {
  const titleId = useId();
  const [present, setPresent] = useState(open);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (open) {
      setPresent(true);
      setClosing(false);
      return undefined;
    }
    if (!present) return undefined;
    setClosing(true);
    const timer = window.setTimeout(() => {
      setPresent(false);
      setClosing(false);
    }, DIALOG_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [open, present]);

  useEffect(() => {
    if (!open) return undefined;
    function onKeyDown(event) {
      if (event.key === "Escape") onClose?.();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  if (!present || typeof document === "undefined") return null;

  return createPortal(
    <div
      className={`workspace-dialog-backdrop ${closing ? "is-closing" : ""}`.trim()}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose?.();
      }}
      role="presentation"
    >
      <article aria-labelledby={titleId} aria-modal="true" className={`workspace-dialog ${className}`.trim()} role="dialog">
        <header className="workspace-dialog-header">
          <span className="workspace-dialog-icon" aria-hidden="true">{icon}</span>
          <div>
            {eyebrow ? <span>{eyebrow}</span> : null}
            <h2 id={titleId}>{title}</h2>
            {description ? <p>{description}</p> : null}
          </div>
          <button aria-label="关闭弹窗" className="workspace-dialog-close" onClick={onClose} type="button">
            <svg aria-hidden="true" fill="none" viewBox="0 0 20 20" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7"><path d="m6 6 8 8M14 6l-8 8" /></svg>
          </button>
        </header>
        <div className="workspace-dialog-body">{children}</div>
        {footer ? <footer className="workspace-dialog-footer">{footer}</footer> : null}
      </article>
    </div>,
    document.body
  );
}
