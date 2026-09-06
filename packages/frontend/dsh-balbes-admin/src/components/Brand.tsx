/**
 * Brand mark shared by the Login card and the Sidebar: blue square dot,
 * the "balbes" wordmark in mono and the small subtitle. Layout (row or
 * column, spacing) is driven by the parent context via `.brand` classes.
 */
interface BrandProps {
  className?: string;
}

export default function Brand({ className }: BrandProps) {
  const cls = className !== undefined ? `brand ${className}` : "brand";
  return (
    <div className={cls}>
      <span className="dot" aria-hidden="true" />
      <span className="brand-text">
        <span className="name">balbes</span>
        <span className="sub">DeepSeek Harness · admin</span>
      </span>
    </div>
  );
}
