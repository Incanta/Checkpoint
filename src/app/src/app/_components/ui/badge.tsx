import { type ReactNode } from "react";

const variants = {
  default:
    "bg-[var(--color-bg-overlay)] text-[var(--color-text-secondary)]",
  accent:
    "bg-[var(--color-accent-muted)] text-[var(--color-accent)]",
  success:
    "bg-[var(--color-success)]/15 text-[var(--color-success)]",
  danger:
    "bg-[var(--color-danger)]/15 text-[var(--color-danger)]",
  info:
    "bg-[var(--color-info)]/15 text-[var(--color-info)]",
  warning:
    "bg-[var(--color-warning)]/15 text-[var(--color-warning)]",
};

interface BadgeProps {
  variant?: keyof typeof variants;
  children: ReactNode;
  className?: string;
}

export function Badge({ variant = "default", children, className = "" }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${variants[variant]} ${className}`}
    >
      {children}
    </span>
  );
}
