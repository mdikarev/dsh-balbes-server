import { useHealth } from "../hooks/useHealth";

interface TopbarProps {
  onLogout: () => void;
}

/** Top bar of the shell: breadcrumb, live health chip and logout action. */
export default function Topbar({ onLogout }: TopbarProps) {
  const health = useHealth();
  return (
    <div className="topbar">
      <span className="crumb">
        balbes / <b>Тестовая страница</b>
      </span>
      <span className="spacer" />
      <span className={`chip ${health === "ok" ? "ok" : "down"}`} role="status">
        <i aria-hidden="true" />
        {health === "ok" ? "сервис активен" : "сервис недоступен"}
      </span>
      <button type="button" className="btn-ghost" onClick={onLogout}>
        Выйти
      </button>
    </div>
  );
}
