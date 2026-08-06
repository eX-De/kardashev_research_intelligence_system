import { useTranslation } from "react-i18next";

export function LocalizedPromptEditor({
  settings = {},
  onSettingChange = () => {},
  modeField,
  localeField,
  customPromptField,
  defaultsField,
  translationPrefix,
  editorId
}) {
  const { i18n, t } = useTranslation("settings");
  const promptLocale = String(i18n.resolvedLanguage || i18n.language || "zh-CN").toLowerCase().startsWith("en") ? "en" : "zh-CN";
  const promptDefaults = settings[defaultsField] || {};
  const localizedDefaultPrompt = String(promptDefaults[promptLocale] || promptDefaults["zh-CN"] || settings[customPromptField] || "");
  const customPrompt = String(settings[customPromptField] || "");
  const promptMode = settings[modeField] === "custom" ? "custom" : "default";
  const promptValue = promptMode === "custom" ? customPrompt : localizedDefaultPrompt;
  const hintId = `${editorId}-language-hint`;

  function changePromptMode(nextMode) {
    if (nextMode === promptMode) return;
    if (nextMode === "custom" && (!customPrompt.trim() || Object.values(promptDefaults).includes(customPrompt.trim()))) {
      onSettingChange(customPromptField, localizedDefaultPrompt);
    }
    onSettingChange(modeField, nextMode);
    onSettingChange(localeField, promptLocale);
  }

  return (
    <div className="paper-prompt-editor localized-prompt-editor">
      <div className="paper-prompt-mode-row">
        <span>
          <strong>{t(`${translationPrefix}.mode.label`)}</strong>
          <small>{t(`${translationPrefix}.mode.${promptMode}Hint`)}</small>
        </span>
        <div className="paper-prompt-mode-control" role="radiogroup" aria-label={t(`${translationPrefix}.mode.label`)}>
          {["default", "custom"].map((mode) => (
            <button aria-checked={promptMode === mode} className={promptMode === mode ? "active" : ""} key={mode} onClick={() => changePromptMode(mode)} role="radio" type="button">
              {t(`${translationPrefix}.mode.${mode}`)}
            </button>
          ))}
        </div>
      </div>
      <label>
        <span>{t(promptMode === "custom" ? `${translationPrefix}.customField` : `${translationPrefix}.defaultField`)}</span>
        <textarea aria-describedby={hintId} onChange={(event) => onSettingChange(customPromptField, event.target.value)} readOnly={promptMode === "default"} value={promptValue} />
      </label>
      <small className="paper-prompt-language-hint" id={hintId}>{t(`${translationPrefix}.languageHint`, { language: t(`${translationPrefix}.languages.${promptLocale}`) })}</small>
    </div>
  );
}
