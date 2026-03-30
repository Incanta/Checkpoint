"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "~/trpc/react";
import { Button, Card, PageHeader, Tabs, Tab } from "~/app/_components/ui";
import { useDocumentTitle } from "~/app/_hooks/useDocumentTitle";

export default function OrgSettingsPage() {
  const params = useParams<{ orgName: string }>();
  const orgName = decodeURIComponent(params.orgName);
  useDocumentTitle(`Settings · ${orgName}`);
  const router = useRouter();
  const utils = api.useUtils();

  const { data: org } = api.org.getOrg.useQuery({
    id: orgName,
    idIsName: true,
  });

  const [name, setName] = useState("");
  const [defaultAccess, setDefaultAccess] = useState("");
  const [defaultCanCreate, setDefaultCanCreate] = useState(true);
  const [initialized, setInitialized] = useState(false);

  if (org && !initialized) {
    setName(org.name);
    setDefaultAccess((org as Record<string, unknown>).defaultRepoAccess as string ?? "NONE");
    setDefaultCanCreate((org as Record<string, unknown>).defaultCanCreateRepos as boolean ?? true);
    setInitialized(true);
  }

  const updateOrg = api.org.updateOrg.useMutation({
    onSuccess: (updated) => {
      void utils.org.myOrgs.invalidate();
      void utils.org.getOrg.invalidate();
      if (updated.name !== orgName) {
        router.replace(`/${updated.name}/settings`);
      }
    },
  });

  const deleteOrg = api.org.deleteOrg.useMutation({
    onSuccess: () => {
      void utils.org.myOrgs.invalidate();
      router.push("/");
    },
  });

  const [showDelete, setShowDelete] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    if (!org) return;
    updateOrg.mutate({
      id: org.id,
      name: name.trim() || undefined,
      defaultRepoAccess: (defaultAccess as "NONE" | "READ" | "WRITE" | "ADMIN") || undefined,
      defaultCanCreateRepos: defaultCanCreate,
    });
  };

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title={`${orgName} settings`}
        breadcrumbs={
          <span>
            <a href={`/${orgName}`} className="text-[var(--color-info)] hover:underline">
              {orgName}
            </a>
            {" / Settings"}
          </span>
        }
      />

      <Tabs className="mb-6">
        <Tab href={`/${orgName}/settings`} exact>
          General
        </Tab>
        <Tab href={`/${orgName}/settings/members`}>Members</Tab>
      </Tabs>

      <div className="space-y-6">
        <Card>
          <form onSubmit={handleSave} className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-[var(--color-text-primary)]">
                Organization name
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)] focus:ring-1 focus:ring-[var(--color-accent)]"
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-[var(--color-text-primary)]">
                Default repository access
              </label>
              <select
                value={defaultAccess}
                onChange={(e) => setDefaultAccess(e.target.value)}
                className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
              >
                <option value="NONE">None</option>
                <option value="READ">Read</option>
                <option value="WRITE">Write</option>
                <option value="ADMIN">Admin</option>
              </select>
            </div>

            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                id="canCreate"
                checked={defaultCanCreate}
                onChange={(e) => setDefaultCanCreate(e.target.checked)}
                className="h-4 w-4 accent-[var(--color-accent)]"
              />
              <label htmlFor="canCreate" className="text-sm text-[var(--color-text-primary)]">
                Members can create repositories by default
              </label>
            </div>

            {updateOrg.error && (
              <p className="text-sm text-[var(--color-danger)]">{updateOrg.error.message}</p>
            )}
            {updateOrg.isSuccess && (
              <p className="text-sm text-[var(--color-success)]">Settings saved.</p>
            )}

            <div className="flex justify-end">
              <Button type="submit" disabled={updateOrg.isPending}>
                {updateOrg.isPending ? "Saving..." : "Save changes"}
              </Button>
            </div>
          </form>
        </Card>

        {/* Danger zone */}
        <Card className="border-[var(--color-danger)]/30">
          <h3 className="mb-3 text-lg font-semibold text-[var(--color-danger)]">
            Danger zone
          </h3>
          {!showDelete ? (
            <Button variant="danger" size="sm" onClick={() => setShowDelete(true)}>
              Delete this organization
            </Button>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-[var(--color-text-secondary)]">
                Type <strong>{orgName}</strong> to confirm deletion. This cannot be undone.
              </p>
              <input
                type="text"
                value={deleteConfirm}
                onChange={(e) => setDeleteConfirm(e.target.value)}
                placeholder={orgName}
                className="w-full rounded-md border border-[var(--color-danger)]/50 bg-[var(--color-bg-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none"
              />
              <div className="flex gap-2">
                <Button
                  variant="danger"
                  size="sm"
                  disabled={deleteConfirm !== orgName || deleteOrg.isPending}
                  onClick={() => org && deleteOrg.mutate({ id: org.id })}
                >
                  {deleteOrg.isPending ? "Deleting..." : "Delete organization"}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setShowDelete(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
