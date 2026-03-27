"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode } from "react";

interface TabsProps {
  children: ReactNode;
  className?: string;
}

export function Tabs({ children, className = "" }: TabsProps) {
  return (
    <nav
      className={`flex gap-0 border-b border-[var(--color-border-default)] ${className}`}
    >
      {children}
    </nav>
  );
}

interface TabProps {
  href: string;
  children: ReactNode;
  exact?: boolean;
}

export function Tab({ href, children, exact }: TabProps) {
  const pathname = usePathname();
  const active = exact ? pathname === href : pathname.startsWith(href);

  return (
    <Link
      href={href}
      className={`relative px-4 py-2 text-sm font-medium transition-colors ${
        active
          ? "text-[var(--color-text-primary)]"
          : "text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
      }`}
    >
      {children}
      {active && (
        <span className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-[var(--color-accent)]" />
      )}
    </Link>
  );
}
