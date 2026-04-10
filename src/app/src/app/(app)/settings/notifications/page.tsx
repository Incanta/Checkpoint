"use client";

import { useState, useEffect } from "react";
import { api } from "~/trpc/react";
import { Card, PageHeader, Button } from "~/app/_components/ui";
import { useDocumentTitle } from "~/app/_hooks/useDocumentTitle";

interface PreferenceToggle {
  key: "accountSecurity" | "orgActivity" | "repoActivity" | "mentions";
  label: string;
  description: string;
}

const CATEGORIES: PreferenceToggle[] = [
  {
    key: "accountSecurity",
    label: "Account & Security",
    description:
      "Password changes, new sign-ins, and other security-related alerts.",
  },
  {
    key: "orgActivity",
    label: "Organization Activity",
    description: "Member invitations, role changes, and organization updates.",
  },
  {
    key: "repoActivity",
    label: "Repository Activity",
    description:
      "Changelist submissions, branch creation, and repository changes.",
  },
  {
    key: "mentions",
    label: "Mentions & Direct",
    description:
      "When someone mentions you or sends you a direct notification.",
  },
];

function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? "bg-[var(--color-accent)]" : "bg-[var(--color-bg-tertiary)]"
      }`}
    >
      <span
        className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
          checked ? "translate-x-5" : "translate-x-0"
        }`}
      />
    </button>
  );
}

export default function NotificationsSettingsPage() {
  useDocumentTitle("Notifications · Settings · Checkpoint VCS");

  const { data: prefs, isLoading } = api.email.getPreferences.useQuery();
  const utils = api.useUtils();

  const [local, setLocal] = useState<Record<string, boolean>>({});
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    if (prefs && !initialized) {
      setLocal({
        accountSecurity: prefs.accountSecurity,
        orgActivity: prefs.orgActivity,
        repoActivity: prefs.repoActivity,
        mentions: prefs.mentions,
      });
      setInitialized(true);
    }
  }, [prefs, initialized]);

  const updatePrefs = api.email.updatePreferences.useMutation({
    onSuccess: () => {
      void utils.email.getPreferences.invalidate();
    },
  });

  const handleToggle = (key: string, value: boolean) => {
    setLocal((prev) => ({ ...prev, [key]: value }));
    updatePrefs.mutate({ [key]: value });
  };

  const allOn = CATEGORIES.every((c) => local[c.key] === true);
  const allOff = CATEGORIES.every((c) => local[c.key] === false);

  const handleBulk = (value: boolean) => {
    const update: Record<string, boolean> = {};
    for (const c of CATEGORIES) {
      update[c.key] = value;
    }
    setLocal(update);
    updatePrefs.mutate(update);
  };

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="Notifications"
        description="Choose which emails you'd like to receive."
      />

      {isLoading ? (
        <div className="py-8 text-center text-sm text-[var(--color-text-muted)]">
          Loading…
        </div>
      ) : (
        <>
          {/* Bulk actions */}
          <div className="mb-4 flex items-center gap-2">
            <Button
              size="sm"
              variant={allOn ? "primary" : "secondary"}
              onClick={() => handleBulk(true)}
              disabled={allOn || updatePrefs.isPending}
            >
              Enable all
            </Button>
            <Button
              size="sm"
              variant={allOff ? "danger" : "secondary"}
              onClick={() => handleBulk(false)}
              disabled={allOff || updatePrefs.isPending}
            >
              Disable all
            </Button>
          </div>

          <Card padding={false}>
            <div className="divide-y divide-[var(--color-border-muted)]">
              {CATEGORIES.map((cat) => (
                <div
                  key={cat.key}
                  className="flex items-center justify-between gap-4 px-5 py-4"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-[var(--color-text-primary)]">
                      {cat.label}
                    </div>
                    <div className="mt-0.5 text-sm text-[var(--color-text-secondary)]">
                      {cat.description}
                    </div>
                  </div>
                  <Toggle
                    checked={local[cat.key] ?? true}
                    onChange={(v) => handleToggle(cat.key, v)}
                    disabled={updatePrefs.isPending}
                  />
                </div>
              ))}
            </div>
          </Card>

          {updatePrefs.isError && (
            <p className="mt-3 text-sm text-[var(--color-danger)]">
              Failed to save preferences. Please try again.
            </p>
          )}
        </>
      )}
    </div>
  );
}
