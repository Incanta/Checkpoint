"use client";

import { useEffect } from "react";
import { api } from "~/trpc/react";
import { Button } from "~/app/_components/ui";
import {
  RESTRICTED_STATUS_LABELS,
  RESTRICTED_STATUS_MESSAGES,
  type RestrictedSubscriptionStatus,
} from "~/lib/subscription";

interface ContactAdminModalProps {
  orgId: string;
  orgName: string;
  status: RestrictedSubscriptionStatus;
  onClose: () => void;
}

export function ContactAdminModal({
  orgId,
  orgName,
  status,
  onClose,
}: ContactAdminModalProps) {
  const { data: admins, isLoading } = api.org.getAdmins.useQuery({ orgId });

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h3 className="text-lg font-semibold text-[var(--color-text-primary)]">
            {orgName} · {RESTRICTED_STATUS_LABELS[status]}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
            aria-label="Close"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
            </svg>
          </button>
        </div>

        <p className="mb-4 text-sm text-[var(--color-text-secondary)]">
          {RESTRICTED_STATUS_MESSAGES[status]}
        </p>

        <div className="mb-4">
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
            Contact an organization admin
          </h4>

          {isLoading && (
            <p className="text-sm text-[var(--color-text-muted)]">Loading…</p>
          )}

          {!isLoading && admins?.length === 0 && (
            <p className="text-sm text-[var(--color-text-muted)]">
              No admins found for this organization.
            </p>
          )}

          {!isLoading && admins && admins.length > 0 && (
            <ul className="divide-y divide-[var(--color-border-muted)] rounded-md border border-[var(--color-border-default)]">
              {admins.map((admin) => (
                <li
                  key={admin.id}
                  className="flex items-center justify-between gap-3 px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm text-[var(--color-text-primary)]">
                      {admin.name ?? admin.email}
                    </div>
                    <div className="truncate text-xs text-[var(--color-text-muted)]">
                      {admin.email}
                    </div>
                  </div>
                  <a
                    href={`mailto:${admin.email}`}
                    className="shrink-0 text-xs font-medium text-[var(--color-info)] hover:underline"
                  >
                    Email
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex justify-end">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
