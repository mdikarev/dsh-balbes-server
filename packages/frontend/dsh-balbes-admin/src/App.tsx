import { useEffect, useState } from "react";
import { TOKEN_KEY, type AdminApi } from "./api/client";
import Sidebar from "./components/Sidebar";
import Topbar from "./components/Topbar";
import Login from "./pages/Login";
import TestPage from "./pages/TestPage";

type View = "loading" | "login" | "main";

export default function App({ api }: { api: AdminApi }) {
  const [view, setView] = useState<View>("loading");

  useEffect(() => {
    let cancelled = false;
    void api
      .me()
      .then(() => { if (!cancelled) setView("main"); })
      .catch(() => { if (!cancelled) setView("login"); });
    api.onUnauthorized(() => setView("login"));
    return () => { cancelled = true; };
  }, [api]);

  function handleLogout(): void {
    localStorage.removeItem(TOKEN_KEY);
    setView("login");
  }

  if (view === "loading") return <div className="loading-screen">Loading…</div>;
  if (view === "login") return <Login api={api} onLogin={() => setView("main")} />;
  return (
    <div className="app-shell">
      <Sidebar active="test" />
      <main className="content">
        <Topbar onLogout={handleLogout} />
        <TestPage api={api} />
      </main>
    </div>
  );
}
