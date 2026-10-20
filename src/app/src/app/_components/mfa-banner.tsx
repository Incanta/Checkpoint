"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { api } from "~/trpc/react";

/**
 * Shown on every page while an org the user belongs to requires MFA they
 * don't have, so an org that suddenly looks empty explains itself.
 */
export function MfaBanner() {
  const pathname = usePathname();
  const { data: security } = api.user.security.useQuery();

  const blocked = security?.blockedOrgs ?? [];
  if (blocked.length === 0 || pathname === "/settings/security") return null;

  return (
    <div className="border-b border-[var(--color-border-default)] bg-[var(--color-danger)]/10 px-4 py-2">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-4">
        <p className="text-sm text-[var(--color-danger)]">
          {blocked.map((o) => o.name).join(", ")}{" "}
          {blocked.length === 1 ? "requires" : "require"} two-factor
          authentication. You can&apos;t access{" "}
          {blocked.length === 1 ? "its" : "their"} repositories until you set it
          up.
        </p>
        <Link
          href="/settings/security"
          className="shrink-0 text-sm font-medium text-[var(--color-accent)] hover:underline"
        >
          Set up two-factor →
        </Link>
      </div>
    </div>
  );
}
