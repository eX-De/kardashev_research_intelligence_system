import { useState } from "react";
import { useTranslation } from "react-i18next";

import { LanguageControl } from "./LanguageControl.jsx";
import { formatApiError } from "../lib/systemMessages.js";
import "../styles/LoginView.css";

export function LoginView({ onLogin }) {
  const { t } = useTranslation(["shell", "common"]);
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [password, setPassword] = useState("");

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!password) {
      setError(t("login.passwordRequired"));
      return;
    }

    setError("");
    setIsSubmitting(true);
    try {
      await onLogin(password);
    } catch (submitError) {
      setError(formatApiError(submitError, t, "shell:login.failed"));
      setIsSubmitting(false);
    }
  };

  return (
    <main className="login-page">
      <section className="login-panel" aria-labelledby="login-title">
        <div className="login-brand">
          <span className="brand-mark">
            <img src="/kris-logo.svg" alt="" />
          </span>
          <div>
            <strong id="login-title">KRIS</strong>
            <span>Kardashev Research Intelligence System</span>
          </div>
          <LanguageControl />
        </div>

        <form className="login-form" noValidate onSubmit={handleSubmit}>
          <label className="login-field">
            <span>{t("login.password")}</span>
            <input
              aria-describedby={error ? "login-error" : undefined}
              aria-invalid={Boolean(error)}
              autoComplete="current-password"
              autoFocus
              disabled={isSubmitting}
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              value={password}
            />
          </label>

          {error ? (
            <p className="login-error" id="login-error" role="alert">
              {error}
            </p>
          ) : null}

          <button className={`primary ${isSubmitting ? "is-busy" : ""}`} disabled={isSubmitting} type="submit">
            {isSubmitting ? (
              <span className="inline-loader compact">
                <span className="loader-dot" aria-hidden="true" />
                {t("login.verifying")}
              </span>
            ) : (
              t("actions.login", { ns: "common" })
            )}
          </button>
        </form>
      </section>
    </main>
  );
}
