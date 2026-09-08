import Brand from "./Brand";

interface NavItem {
  /** Page id; live items navigate, ghost items have none. */
  id?: string;
  label: string;
  soon: boolean;
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    title: "Работа",
    items: [
      { id: "test", label: "Тестовая страница", soon: false },
      { id: "workspaces", label: "Проекты", soon: false }
    ]
  },
  {
    title: "Управление",
    items: [
      { id: "models", label: "Модели", soon: false },
      { label: "Скиллы", soon: true },
      { label: "Агенты", soon: true },
      { label: "Команды", soon: true }
    ]
  },
  {
    title: "Система",
    items: [{ label: "Настройки", soon: true }]
  }
];

interface SidebarProps {
  /** Id of the active page. */
  active: string;
  /** Called with the page id when a live nav item is clicked. */
  onNavigate(id: string): void;
}

/**
 * Left application navigation. Items with an `id` are live buttons that call
 * onNavigate and carry aria-current="page" when active; ghost items stay
 * grayed out and non-interactive.
 */
export default function Sidebar({ active, onNavigate }: SidebarProps) {
  return (
    <aside className="sidebar">
      <Brand />
      <nav>
        {NAV_GROUPS.map((group) => (
          <div className="nav-block" key={group.title}>
            <p className="nav-group">{group.title}</p>
            {group.items.map((item) => {
              const isActive = item.id !== undefined && item.id === active;
              const classes = ["nav-item"];
              if (isActive) classes.push("active");
              else if (item.soon) classes.push("ghost");
              if (item.id !== undefined) {
                return (
                  <button
                    type="button"
                    className={classes.join(" ")}
                    key={item.label}
                    onClick={() => item.id !== undefined && onNavigate(item.id)}
                    aria-current={isActive ? "page" : undefined}
                  >
                    {item.label}
                    {item.soon && <span className="soon">скоро</span>}
                  </button>
                );
              }
              return (
                <span className={classes.join(" ")} key={item.label}>
                  {item.label}
                  {item.soon && <span className="soon">скоро</span>}
                </span>
              );
            })}
          </div>
        ))}
      </nav>
    </aside>
  );
}
