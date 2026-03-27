"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "~/trpc/react";
import { Button, Card, PageHeader } from "~/app/_components/ui";
import { useDocumentTitle } from "~/app/_hooks/useDocumentTitle";

export default function NewRepoPage() {
  useDocumentTitle("New Repository · Checkpoint VCS");
  const searchParams = useSearchParams();
  const preselectedOrg = searchParams.get("org") ?? "";
  const [name, setName] = useState("");
  const [selectedOrgId, setSelectedOrgId] = useState("");
  const router = useRouter();
  const utils = api.useUtils();

  const { data: orgs } = api.org.myOrgs.useQuery();

  // Resolve preselected org name to ID
  const resolvedOrgId =
    selectedOrgId ||
    orgs?.find((o) => o.name === preselectedOrg)?.id ||
    orgs?.[0]?.id ||
    "";
  const selectedOrgName =
    orgs?.find((o) => o.id === resolvedOrgId)?.name ?? "";

  const createRepo = api.repo.createRepo.useMutation({
    onSuccess: () => {
      void utils.org.myOrgs.invalidate();
      router.push(`/${selectedOrgName}/${name.trim()}`);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim() && resolvedOrgId) {
      createRepo.mutate({
        name: name.trim(),
        orgId: resolvedOrgId,
      });
    }
  };

  return (
    <div className="mx-auto max-w-lg">
      <PageHeader
        title="Create a new repository"
        description="Repositories contain all your project files and version history."
      />

      <Card>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="org-select"
              className="mb-1 block text-sm font-medium text-[var(--color-text-primary)]"
            >
              Owner
            </label>
            <select
              id="org-select"
              value={resolvedOrgId}
              onChange={(e) => setSelectedOrgId(e.target.value)}
              className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)] focus:ring-1 focus:ring-[var(--color-accent)]"
            >
              {orgs?.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="repo-name"
              className="mb-1 block text-sm font-medium text-[var(--color-text-primary)]"
            >
              Repository name
            </label>
            <input
              id="repo-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-project"
              autoFocus
              className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)] focus:ring-1 focus:ring-[var(--color-accent)]"
            />
          </div>

          {createRepo.error && (
            <p className="text-sm text-[var(--color-danger)]">
              {createRepo.error.message}
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
              disabled={!name.trim() || !resolvedOrgId || createRepo.isPending}
            >
              {createRepo.isPending ? "Creating..." : "Create repository"}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
