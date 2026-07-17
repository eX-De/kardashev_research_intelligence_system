import { useEffect, useId, useMemo, useRef, useState } from "react";
import "../styles/WorkspaceSelect.css";

function normalizeOptions(options) {
  return options.map((option) => {
    if (Array.isArray(option)) return { value: option[0], label: option[1], disabled: false };
    return { value: option.value, label: option.label, disabled: Boolean(option.disabled) };
  });
}

export function WorkspaceSelect({ ariaLabel, className = "", disabled = false, onChange, options, value }) {
  const selectId = useId();
  const rootRef = useRef(null);
  const [open, setOpen] = useState(false);
  const normalized = useMemo(() => normalizeOptions(options), [options]);
  const selectedIndex = Math.max(0, normalized.findIndex((option) => String(option.value) === String(value)));
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const selected = normalized[selectedIndex] || normalized[0];

  useEffect(() => {
    if (!open) setActiveIndex(selectedIndex);
  }, [open, selectedIndex]);

  useEffect(() => {
    if (!open) return undefined;
    function closeOnOutsidePointer(event) {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  function moveActive(direction) {
    if (!normalized.length) return;
    let next = activeIndex;
    for (let attempts = 0; attempts < normalized.length; attempts += 1) {
      next = (next + direction + normalized.length) % normalized.length;
      if (!normalized[next]?.disabled) {
        setActiveIndex(next);
        return;
      }
    }
  }

  function choose(option) {
    if (!option || option.disabled) return;
    onChange?.(option.value);
    setOpen(false);
  }

  function onKeyDown(event) {
    if (disabled) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        setActiveIndex(selectedIndex);
      } else {
        moveActive(event.key === "ArrowDown" ? 1 : -1);
      }
      return;
    }
    if (!open && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      setOpen(true);
      return;
    }
    if (!open) return;
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const direction = event.key === "Home" ? 1 : -1;
      let next = event.key === "Home" ? 0 : normalized.length - 1;
      while (normalized[next]?.disabled && next >= 0 && next < normalized.length) next += direction;
      if (next >= 0 && next < normalized.length) setActiveIndex(next);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(normalized[activeIndex]);
    } else if (event.key === "Escape" || event.key === "Tab") {
      setOpen(false);
    }
  }

  return (
    <div className={`workspace-select ${open ? "is-open" : ""} ${className}`.trim()} ref={rootRef}>
      <button
        aria-activedescendant={open ? `${selectId}-option-${activeIndex}` : undefined}
        aria-controls={`${selectId}-listbox`}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        className="workspace-select-trigger"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={onKeyDown}
        type="button"
      >
        <span>{selected?.label || "请选择"}</span>
        <svg aria-hidden="true" fill="none" viewBox="0 0 20 20" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7"><path d="m6.5 8 3.5 3.5L13.5 8" /></svg>
      </button>
      {open ? (
        <div aria-label={ariaLabel} className="workspace-select-menu" id={`${selectId}-listbox`} role="listbox">
          {normalized.map((option, index) => {
            const selectedOption = String(option.value) === String(value);
            return (
              <button
                aria-selected={selectedOption}
                className={`${selectedOption ? "is-selected" : ""} ${activeIndex === index ? "is-active" : ""}`.trim()}
                disabled={option.disabled}
                id={`${selectId}-option-${index}`}
                key={String(option.value)}
                onClick={() => choose(option)}
                onMouseEnter={() => { if (!option.disabled) setActiveIndex(index); }}
                role="option"
                type="button"
              >
                <span>{option.label}</span>
                <i aria-hidden="true">✓</i>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
