import { useEffect, useState } from "react";
import { TOKEN_KEY, type AdminApi } from "./api/client";
import Sidebar from "./components/Sidebar";
import Topbar from "./components/Topbar";
import Login from "./pages/Login";
import TestPage from "./pages/TestPage";
import WorkspacesPage from "./pages/WorkspacesPage";

type View = "loading" | "login" | "main";
type Page = "test" | "workspaces";

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
        <Topbar title={page === "test" ? "Тестовая страница" : "Проекты"} onLogout={handleLogout} />
        {page === "test" ? <TestPage api={api} /> : <WorkspacesPage api={api} />}
      </main>
    </div>
  );
}
