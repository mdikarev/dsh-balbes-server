import { useEffect, useState, type FormEvent } from "react";
import { createApiClient, type AdminApi } from "./api/client";

type View = "loading" | "login" | "main";

const TEST_PROMPT = "Напиши 'ok' и больше ничего";

export default function App({ api }: { api: AdminApi }) {
  const [view, setView] = useState<View>("loading");
  const [loginValue, setLoginValue] = useState("");
  const [passwordValue, setPasswordValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api
      .me()
      .then(() => { if (!cancelled) setView("main"); })
      .catch(() => { if (!cancelled) setView("login"); });
    api.onUnauthorized(() => setView("login"));
    return () => { cancelled = true; };
  }, [api]);

  async function handleLogin(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.login(loginValue, passwordValue);
      setView("main");
    } catch (err) {
      setError(err instanceof Error ? err.message : "login failed");
    }
  }

  async function handlePrompt() {
    setBusy(true);
    setError(null);
    setAnswer(null);
    try {
      const res = await api.prompt(TEST_PROMPT);
      setAnswer(res.text);
    } catch (err) {
      setError(err instanceof Error ? err.message : "prompt failed");
    } finally {
      setBusy(false);
    }
  }

  if (view === "loading") return <div>Loading…</div>;
  if (view === "login") {
    return (
      <main>
        <h1>balbes admin</h1>
        <form onSubmit={handleLogin} data-testid="login-form">
          <label>
            Login
            <input value={loginValue} onChange={(e) => setLoginValue(e.target.value)} data-testid="login-input" autoComplete="username" />
          </label>
          <label>
            Password
            <input type="password" value={passwordValue} onChange={(e) => setPasswordValue(e.target.value)} data-testid="password-input" autoComplete="current-password" />
          </label>
          <button type="submit" data-testid="login-submit">Войти</button>
          {error !== null && <p role="alert">{error}</p>}
        </form>
      </main>
    );
  }
  return (
    <main>
      <h1>balbes admin</h1>
      <p>Тестовый промпт: <code>{TEST_PROMPT}</code></p>
      {answer !== null && <pre data-testid="answer">{answer}</pre>}
      <button onClick={() => void handlePrompt()} disabled={busy} data-testid="prompt-button">
        {busy ? "Отправляется…" : "Отправить тестовый промпт"}
      </button>
      {error !== null && <p role="alert">{error}</p>}
    </main>
  );
}
