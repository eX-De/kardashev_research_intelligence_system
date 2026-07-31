import { useTranslation } from "react-i18next";

import { useTheme } from "../lib/theme.jsx";
import "../styles/ThemeControl.css";

const THEME_ICONS = {
  light: "☀",
  dark: "☾",
  system: "◐"
};

export function ThemeControl() {
  const { t } = useTranslation("common");
  const { mode, modes, setMode, systemTheme } = useTheme();
  const systemLabel = t(`theme.${systemTheme}`);

  return (
    <div className="theme-control" role="radiogroup" aria-label={t("theme.label")}>
      {modes.map((item) => {
        const label = item === "system"
          ? t("theme.systemCurrent", { current: systemLabel })
          : t(`theme.${item}`);
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
