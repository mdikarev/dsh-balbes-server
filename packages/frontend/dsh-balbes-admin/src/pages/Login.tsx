import { useState, type FormEvent } from "react";
import type { AdminApi } from "../api/client";
import Brand from "../components/Brand";

interface LoginProps {
  api: AdminApi;
  /** Called after a successful login (App switches to the main view). */
  onLogin: () => void;
}

/** Full-viewport login screen: centered card on a dark radial-glow backdrop. */
export default function Login({ api, onLogin }: LoginProps) {
  const [loginValue, setLoginValue] = useState("");
  const [passwordValue, setPasswordValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    try {
      await api.login(loginValue, passwordValue);
      onLogin();
    } catch (err) {
      setError(err instanceof Error ? err.message : "login failed");
    }
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={(e) => void handleSubmit(e)} data-testid="login-form">
        <Brand />
        <label>
          Логин
          <input
            value={loginValue}
            onChange={(e) => setLoginValue(e.target.value)}
            data-testid="login-input"
            autoComplete="username"
            autoFocus
          />
        </label>
        <label>
          Пароль
          <input
            type="password"
            value={passwordValue}
            onChange={(e) => setPasswordValue(e.target.value)}
            data-testid="password-input"
            autoComplete="current-password"
          />
        </label>
        {error !== null && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn" data-testid="login-submit">
          Войти
        </button>
      </form>
      <p className="login-foot">HTTP · single-user</p>
    </div>
  );
}
