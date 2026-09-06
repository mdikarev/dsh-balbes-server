import { useState } from "react";
import type { AdminApi } from "../api/client";

interface TestPageProps {
  api: AdminApi;
}

const TEST_PROMPT = "Напиши 'ok' и больше ничего";

/**
 * Test page content: fixed prompt note, submit button with busy state and
 * the model answer rendered above the button in a terminal-style box.
 */
export default function TestPage({ api }: TestPageProps) {
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handlePrompt(): Promise<void> {
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

  return (
    <div className="page">
      <h1>Тестовая страница</h1>
      <p className="lead">Проверка связи с агентом: отправляет тестовый промпт в модель.</p>
      <p className="prompt-note">
        Промпт: <code>{TEST_PROMPT}</code>
      </p>
      {answer !== null && (
        <pre className="answer-box" data-testid="answer">
          {answer}
        </pre>
      )}
      <button
        type="button"
        className="btn"
        onClick={() => void handlePrompt()}
        disabled={busy}
        data-testid="prompt-button"
      >
        {busy && <span className="spinner" aria-hidden="true" />}
        {busy ? "Отправляется…" : "Отправить тестовый промпт"}
      </button>
      {error !== null && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
