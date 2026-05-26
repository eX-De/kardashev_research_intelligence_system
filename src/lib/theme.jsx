import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

export const THEME_STORAGE_KEY = "kris.theme.mode";
export const THEME_MODES = ["light", "dark", "system"];
export const THEME_LABELS = {
  light: "浅色",
  dark: "暗色",
  system: "系统"
};

const ThemeContext = createContext(null);

function canUseDom() {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

export function normalizeThemeMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  return THEME_MODES.includes(mode) ? mode : "system";
}

export function systemTheme() {
  if (!canUseDom() || typeof window.matchMedia !== "function") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function resolveTheme(mode, system = systemTheme()) {
  const normalized = normalizeThemeMode(mode);
  return normalized === "system" ? system : normalized;
}

function storedThemeMode() {
  if (!canUseDom()) return "system";
  try {
    return normalizeThemeMode(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

function applyTheme(theme) {
  if (!canUseDom()) return;
  const nextTheme = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = nextTheme;
  document.documentElement.style.colorScheme = nextTheme;
}

export function ThemeProvider({ children }) {
  const [mode, setModeState] = useState(storedThemeMode);
  const [currentSystemTheme, setCurrentSystemTheme] = useState(systemTheme);
  const effectiveTheme = resolveTheme(mode, currentSystemTheme);

  useEffect(() => {
    if (!canUseDom() || typeof window.matchMedia !== "function") return undefined;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (event) => setCurrentSystemTheme(event.matches ? "dark" : "light");
    setCurrentSystemTheme(query.matches ? "dark" : "light");
    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", handleChange);
      return () => query.removeEventListener("change", handleChange);
    }
    query.addListener?.(handleChange);
    return () => query.removeListener?.(handleChange);
  }, []);

  useEffect(() => {
    applyTheme(effectiveTheme);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, mode);
    } catch {
      // localStorage can be unavailable in hardened browser contexts.
    }
  }, [effectiveTheme, mode]);

  useEffect(() => {
    if (!canUseDom()) return undefined;
    const handleStorage = (event) => {
      if (event.key === THEME_STORAGE_KEY) setModeState(normalizeThemeMode(event.newValue));
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const setMode = useCallback((nextMode) => {
    setModeState(normalizeThemeMode(nextMode));
  }, []);

  const value = useMemo(() => ({
    effectiveTheme,
    mode,
    modes: THEME_MODES,
    setMode,
    systemTheme: currentSystemTheme
  }), [currentSystemTheme, effectiveTheme, mode, setMode]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside ThemeProvider");
  return value;
}
