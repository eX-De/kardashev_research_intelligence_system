import { useTranslation } from "react-i18next";

import { useLocale } from "../lib/locale.jsx";
import "../styles/LanguageControl.css";

export function LanguageControl() {
  const { t } = useTranslation("common");
  const { locale, locales, setLocale } = useLocale();

  return (
    <div className="language-control" role="radiogroup" aria-label={t("language.label")}>
      {locales.map((item) => (
        <button
          aria-checked={locale === item}
          aria-label={t(`language.${item}.full`)}
          className={locale === item ? "active" : ""}
          key={item}
          onClick={() => setLocale(item)}
          role="radio"
          title={t(`language.${item}.full`)}
          type="button"
        >
          {t(`language.${item}.short`)}
        </button>
      ))}
    </div>
  );
}
