import { useEffect, useState } from "react";
import { TOKEN_KEY, type AdminApi } from "./api/client";
import Sidebar from "./components/Sidebar";
import Topbar from "./components/Topbar";
import Login from "./pages/Login";
import WorkspacesPage from "./pages/WorkspacesPage";
import ModelsPage from "./pages/ModelsPage";
import TelegramPage from "./pages/TelegramPage";
import MemoryPage from "./pages/MemoryPage";

type View = "loading" | "login" | "main";
type Page = "workspaces" | "models" | "telegram" | "memory";

const PAGE_TITLES: Record<Page, string> = {
  workspaces: "Проекты",
  models: "Модели",
  telegram: "Telegram",
  memory: "Память"
};

export default function App({ api }: { api: AdminApi }) {
  const [view, setView] = useState<View>("loading");
  const [page, setPage] = useState<Page>("workspaces");

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
    setPage("workspaces");
    setView("login");
  }

  function handleLogin(): void {
    setPage("workspaces");
    setView("main");
  }

  if (view === "loading") return <div className="loading-screen">Loading…</div>;
  if (view === "login") return <Login api={api} onLogin={handleLogin} />;
  return (
    <div className="app-shell">
      <Sidebar active={page} onNavigate={(id) => setPage(id as Page)} />
      <main className="content">
        <Topbar title={PAGE_TITLES[page]} onLogout={handleLogout} />
        {page === "workspaces" ? (
          <WorkspacesPage api={api} />
        ) : page === "models" ? (
          <ModelsPage api={api} />
        ) : page === "telegram" ? (
          <TelegramPage api={api} />
        ) : (
          <MemoryPage api={api} />
        )}
      </main>
    </div>
  );
}
