"use client";

import { type ReactNode } from "react";

interface CardProps {
  children: ReactNode;
  className?: string;
  padding?: boolean;
}

export function Card({ children, className = "", padding = true }: CardProps) {
  return (
    <div
      className={`rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] ${padding ? "p-4" : ""} ${className}`}
    >
      {children}
    </div>
  );
}
