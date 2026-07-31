import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

export const LOCALE_STORAGE_KEY = "kris.locale";
export const DEFAULT_LOCALE = "zh-CN";
export const SUPPORTED_LOCALES = ["zh-CN", "en"];

const LocaleContext = createContext(null);

function canUseDom() {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

export function normalizeLocale(value) {
  return SUPPORTED_LOCALES.includes(value) ? value : DEFAULT_LOCALE;
}

export function getStoredLocale() {
  if (!canUseDom()) return DEFAULT_LOCALE;
  try {
    return normalizeLocale(window.localStorage.getItem(LOCALE_STORAGE_KEY));
  } catch {
    return DEFAULT_LOCALE;
  }
}

export function LocaleProvider({ children }) {
  const { i18n, t } = useTranslation("app");
  const [locale, setLocaleState] = useState(() => normalizeLocale(i18n.resolvedLanguage || getStoredLocale()));

  const setLocale = useCallback((nextLocale) => {
    setLocaleState(normalizeLocale(nextLocale));
  }, []);

  useEffect(() => {
    if (i18n.resolvedLanguage !== locale) {
      void i18n.changeLanguage(locale).then(() => {
        if (canUseDom()) document.title = i18n.t("title", { ns: "app" });
      });
    }
    if (!canUseDom()) return;
    document.documentElement.lang = locale;
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    } catch {
      // localStorage can be unavailable in hardened browser contexts.
    }
  }, [i18n, locale]);

  useEffect(() => {
    if (!canUseDom()) return undefined;
    const handleStorage = (event) => {
      if (event.key === LOCALE_STORAGE_KEY) setLocaleState(normalizeLocale(event.newValue));
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  useEffect(() => {
    if (canUseDom()) document.title = t("title");
  }, [i18n.resolvedLanguage, t]);

  const value = useMemo(() => ({
    locale,
    locales: SUPPORTED_LOCALES,
    setLocale
  }), [locale, setLocale]);

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale() {
  const value = useContext(LocaleContext);
  if (!value) throw new Error("useLocale must be used inside LocaleProvider");
  return value;
}
