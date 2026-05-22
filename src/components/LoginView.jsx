import { useState } from "react";

export function LoginView({ onLogin }) {
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [password, setPassword] = useState("");

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!password) {
      setError("请输入访问密码");
      return;
    }

    setError("");
    setIsSubmitting(true);
    try {
      await onLogin(password);
    } catch (submitError) {
      setError(submitError.message || "登录失败，请确认密码");
      setIsSubmitting(false);
    }
  };

  return (
    <main className="login-page">
      <section className="login-panel" aria-labelledby="login-title">
        <div className="login-brand">
          <span className="brand-mark">
            <img src="/research-mark.svg" alt="" />
          </span>
          <div>
            <strong id="login-title">科研情报系统</strong>
            <span>访问验证</span>
          </div>
        </div>

        <form className="login-form" noValidate onSubmit={handleSubmit}>
          <label className="login-field">
            <span>访问密码</span>
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
                验证中
              </span>
            ) : (
              "登录"
            )}
          </button>
        </form>
      </section>
    </main>
  );
}
