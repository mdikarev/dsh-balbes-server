import Brand from "./Brand";

interface NavItem {
  /** Page id; only "test" is implemented today. */
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
      { label: "Проекты", soon: true }
    ]
  },
  {
    title: "Управление",
    items: [
      { label: "Ключи", soon: true },
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
  /** Id of the active page ("test" is the only implemented page). */
  active: string;
}

/**
 * Left application navigation. Purely presentational: ghost items are
 * grayed out and non-interactive; the active item gets the accent border.
 */
export default function Sidebar({ active }: SidebarProps) {
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
