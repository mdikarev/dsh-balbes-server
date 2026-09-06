import { useHealth } from "../hooks/useHealth";

interface TopbarProps {
  title: string;
  onLogout: () => void;
}

/** Top bar of the shell: breadcrumb with the page title, health chip, logout. */
export default function Topbar({ title, onLogout }: TopbarProps) {
  const health = useHealth();
  return (
    <div className="topbar">
      <span className="crumb">
        balbes / <b>{title}</b>
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
