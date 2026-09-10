import { useEffect, useState } from "react";
import { TOKEN_KEY, type AdminApi } from "./api/client";
import Sidebar from "./components/Sidebar";
import Topbar from "./components/Topbar";
import Login from "./pages/Login";
import TestPage from "./pages/TestPage";
import WorkspacesPage from "./pages/WorkspacesPage";
import ModelsPage from "./pages/ModelsPage";
import TelegramPage from "./pages/TelegramPage";

type View = "loading" | "login" | "main";
type Page = "test" | "workspaces" | "models" | "telegram";

const PAGE_TITLES: Record<Page, string> = {
  test: "Тестовая страница",
  workspaces: "Проекты",
  models: "Модели",
  telegram: "Telegram"
};

export default function App({ api }: { api: AdminApi }) {
  const [view, setView] = useState<View>("loading");
  const [page, setPage] = useState<Page>("test");

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
    setPage("test");
    setView("login");
  }

  function handleLogin(): void {
    setPage("test");
    setView("main");
  }

  if (view === "loading") return <div className="loading-screen">Loading…</div>;
  if (view === "login") return <Login api={api} onLogin={handleLogin} />;
  return (
    <div className="app-shell">
      <Sidebar active={page} onNavigate={(id) => setPage(id as Page)} />
      <main className="content">
        <Topbar title={PAGE_TITLES[page]} onLogout={handleLogout} />
        {page === "test" ? (
          <TestPage api={api} />
        ) : page === "workspaces" ? (
          <WorkspacesPage api={api} />
        ) : page === "models" ? (
          <ModelsPage api={api} />
        ) : (
          <TelegramPage api={api} />
        )}
      </main>
    </div>
  );
}
