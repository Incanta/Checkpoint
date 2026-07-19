import { type ReactNode } from "react";

interface PageHeaderProps {
  title: ReactNode;
  description?: string;
  actions?: ReactNode;
  breadcrumbs?: ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  description,
  actions,
  breadcrumbs,
  className = "",
}: PageHeaderProps): React.ReactElement {
  return (
    <div className={`mb-6 ${className}`}>
      {breadcrumbs && (
        <div className="mb-2 text-sm text-[var(--color-text-secondary)]">
          {breadcrumbs}
        </div>
      )}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--color-text-primary)]">
            {title}
          </h1>
          {description && (
            <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
              {description}
            </p>
          )}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}
