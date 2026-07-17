import { THEME_LABELS, useTheme } from "../lib/theme.jsx";
import "../styles/ThemeControl.css";

const THEME_ICONS = {
  light: "☀",
  dark: "☾",
  system: "◐"
};

export function ThemeControl() {
  const { mode, modes, setMode, systemTheme } = useTheme();
  const systemLabel = THEME_LABELS[systemTheme] || systemTheme;

  return (
    <div className="theme-control" role="radiogroup" aria-label="主题模式">
      {modes.map((item) => {
        const label = item === "system" ? `跟随系统，当前${systemLabel}` : THEME_LABELS[item];
        return (
          <button
            aria-checked={mode === item}
            aria-label={label}
            className={mode === item ? "active" : ""}
            key={item}
            onClick={() => setMode(item)}
            role="radio"
            title={label}
            type="button"
          >
            <span aria-hidden="true">{THEME_ICONS[item]}</span>
          </button>
        );
      })}
    </div>
  );
}
