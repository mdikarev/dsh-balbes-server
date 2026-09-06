import { useEffect, useState } from "react";

export type HealthStatus = "ok" | "down";

const POLL_INTERVAL_MS = 20_000;

/**
 * Live service health: POSTs /api/health every 20s and reports ok/down.
 * Deliberately does NOT fetch on mount — it starts green ("сервис активен")
 * and only changes after the first poll resolves. The interval is cleared
 * on unmount. No auth header is needed for this endpoint.
 */
export function useHealth(): HealthStatus {
  const [status, setStatus] = useState<HealthStatus>("ok");

  useEffect(() => {
    let cancelled = false;

    async function poll(): Promise<void> {
      try {
        const res = await fetch("/api/health", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}"
        });
        if (!cancelled) setStatus(res.ok ? "ok" : "down");
      } catch {
        if (!cancelled) setStatus("down");
      }
    }

    const id = setInterval(() => {
      void poll();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return status;
}
