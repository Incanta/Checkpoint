import { type ReactNode } from "react";

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className = "",
}: EmptyStateProps): React.ReactElement {
  return (
    <div
      className={`flex flex-col items-center justify-center py-12 text-center ${className}`}
    >
      {icon && <div className="text-[var(--color-text-muted)]">{icon}</div>}
      <h3 className="text-lg font-medium text-[var(--color-text-primary)]">
        {title}
      </h3>
      {description && (
        <p className="mt-1 max-w-sm text-sm text-[var(--color-text-secondary)]">
          {description}
        </p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
