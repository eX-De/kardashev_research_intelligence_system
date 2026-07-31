import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import { DEFAULT_LOCALE, getStoredLocale } from "../lib/locale.jsx";

const localeModules = import.meta.glob("../locales/*/*.json", {
  eager: true,
  import: "default"
});

const resources = Object.entries(localeModules).reduce((result, [path, messages]) => {
  const match = path.match(/\/locales\/([^/]+)\/([^/]+)\.json$/);
  if (!match) return result;
  const [, locale, namespace] = match;
  result[locale] ||= {};
  result[locale][namespace] = messages;
  return result;
}, {});

export const namespaces = [...new Set(
  Object.values(resources).flatMap((localeResources) => Object.keys(localeResources))
)];

i18n
  .use(initReactI18next)
  .init({
    defaultNS: "common",
    fallbackLng: DEFAULT_LOCALE,
    interpolation: { escapeValue: false },
    lng: getStoredLocale(),
    ns: namespaces,
    resources,
    returnEmptyString: false,
    supportedLngs: ["zh-CN", "en"]
  });

export default i18n;
