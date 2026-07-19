import { type ReactNode } from "react";

interface TabsProps {
  children: ReactNode;
  className?: string;
}

export function Tabs({ children, className = "" }: TabsProps): React.ReactElement {
  return (
    <nav
      className={`flex gap-0 border-b border-[var(--color-border-default)] ${className}`}
    >
      {children}
    </nav>
  );
}

interface TabProps {
  active?: boolean;
  onClick?: () => void;
  children: ReactNode;
}

/**
 * Controlled tab. The desktop app switches views by state (not route), so this
 * diverges from the webapp's route-based Tab while keeping the same look.
 */
export function Tab({ active, onClick, children }: TabProps): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative cursor-pointer border-0 bg-transparent px-4 py-2 text-sm font-medium transition-colors ${
        active
          ? "text-[var(--color-text-primary)]"
          : "text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
      }`}
    >
      {children}
      {active && (
        <span className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-[var(--color-accent)]" />
      )}
    </button>
  );
}
