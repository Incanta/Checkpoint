"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "~/trpc/react";
import { Button, Card, PageHeader } from "~/app/_components/ui";
import { useDocumentTitle } from "~/app/_hooks/useDocumentTitle";

export default function NewOrgPage() {
  useDocumentTitle("New Organization · Checkpoint VCS");
  const [name, setName] = useState("");
  const router = useRouter();
  const utils = api.useUtils();

  const createOrg = api.org.createOrg.useMutation({
    onSuccess: (org) => {
      void utils.org.myOrgs.invalidate();
      router.push(`/${org.name}`);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim()) {
      createOrg.mutate({ name: name.trim() });
    }
  };

  return (
    <div className="mx-auto max-w-lg">
      <PageHeader
        title="Create a new organization"
        description="Organizations help you group repositories and manage team access."
      />

      <Card>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="org-name"
              className="mb-1 block text-sm font-medium text-[var(--color-text-primary)]"
            >
              Organization name
            </label>
            <input
              id="org-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-org"
              autoFocus
              className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)] focus:ring-1 focus:ring-[var(--color-accent)]"
            />
          </div>

          {createOrg.error && (
            <p className="text-sm text-[var(--color-danger)]">
              {createOrg.error.message}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              type="button"
              onClick={() => router.back()}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!name.trim() || createOrg.isPending}
            >
              {createOrg.isPending ? "Creating..." : "Create organization"}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
