"use client";

import { useState, useEffect, useMemo } from "react";
import { useParams, useRouter, notFound } from "next/navigation";
import { api } from "~/trpc/react";
import { useSession } from "~/lib/auth-client";
import { Button, Card, PageHeader } from "~/app/_components/ui";
import { useDocumentTitle } from "~/app/_hooks/useDocumentTitle";
import { SettingsTabs } from "./_components/settings-tabs";

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

  const { data: session } = useSession();
  const currentOrgUser = org?.users?.find(
    (u: { userId: string }) => u.userId === session?.user?.id,
  );
  if (org && (!currentOrgUser || currentOrgUser.role !== "ADMIN")) {
    notFound();
  }

  const [name, setName] = useState("");
  const [defaultAccess, setDefaultAccess] = useState("");
  const [defaultCanCreate, setDefaultCanCreate] = useState(true);
  const [initialized, setInitialized] = useState(false);

  if (org && !initialized) {
    setName(org.name);
    setDefaultAccess(org.defaultRepoAccess ?? "NONE");
    setDefaultCanCreate(org.defaultCanCreateRepos ?? true);
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
      defaultRepoAccess:
        (defaultAccess as "NONE" | "READ" | "WRITE" | "ADMIN") || undefined,
      defaultCanCreateRepos: defaultCanCreate,
    });
  };

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title={`${orgName} settings`}
        breadcrumbs={
          <span>
            <a
              href={`/${orgName}`}
              className="text-[var(--color-info)] hover:underline"
            >
              {orgName}
            </a>
            {" / Settings"}
          </span>
        }
      />

      <SettingsTabs orgName={orgName} />

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
              <label
                htmlFor="canCreate"
                className="text-sm text-[var(--color-text-primary)]"
              >
                Members can create repositories by default
              </label>
            </div>

            {updateOrg.error && (
              <p className="text-sm text-[var(--color-danger)]">
                {updateOrg.error.message}
              </p>
            )}
            {updateOrg.isSuccess && (
              <p className="text-sm text-[var(--color-success)]">
                Settings saved.
              </p>
            )}

            <div className="flex justify-end">
              <Button type="submit" disabled={updateOrg.isPending}>
                {updateOrg.isPending ? "Saving..." : "Save changes"}
              </Button>
            </div>
          </form>
        </Card>

        {org && <BinaryExtensionsCard orgId={org.id} />}

        {/* Danger zone */}
        <Card className="border-[var(--color-danger)]/30">
          <h3 className="mb-3 text-lg font-semibold text-[var(--color-danger)]">
            Danger zone
          </h3>
          {!showDelete ? (
            <Button
              variant="danger"
              size="sm"
              onClick={() => setShowDelete(true)}
            >
              Delete this organization
            </Button>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-[var(--color-text-secondary)]">
                Type <strong>{orgName}</strong> to confirm deletion. This cannot
                be undone.
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
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowDelete(false)}
                >
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

function BinaryExtensionsCard({ orgId }: { orgId: string }) {
  const utils = api.useUtils();

  const { data } = api.org.getBinaryExtensions.useQuery({ orgId });

  const [newExt, setNewExt] = useState("");

  const overrides = useMemo(() => {
    if (!data?.overrides) return [] as { op: "+" | "-"; ext: string }[];
    return data.overrides
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean)
      .map((e) => ({
        op: e[0] as "+" | "-",
        ext: e.slice(1),
      }));
  }, [data?.overrides]);

  const updateOrg = api.org.updateOrg.useMutation({
    onSuccess: () => {
      void utils.org.getBinaryExtensions.invalidate({ orgId });
    },
  });

  const saveOverrides = (entries: { op: "+" | "-"; ext: string }[]) => {
    const csv = entries.map((e) => `${e.op}${e.ext}`).join(",");
    updateOrg.mutate({ id: orgId, binaryExtensions: csv });
  };

  const handleAdd = (ext: string, op: "+" | "-") => {
    const normalized = ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
    if (overrides.some((o) => o.ext === normalized && o.op === op)) return;
    saveOverrides([...overrides, { op, ext: normalized }]);
    setNewExt("");
  };

  const handleRemove = (index: number) => {
    saveOverrides(overrides.filter((_, i) => i !== index));
  };

  if (!data) return null;

  return (
    <Card>
      <h3 className="mb-1 text-lg font-semibold text-[var(--color-text-primary)]">
        Binary file extensions
      </h3>
      <p className="mb-4 text-sm text-[var(--color-text-secondary)]">
        Files with these extensions are treated as binary (no text diff or auto-merge).
        Add or remove extensions to customize the list for this organization.
      </p>

      {overrides.length > 0 && (
        <div className="mb-4 space-y-1">
          <label className="block text-sm font-medium text-[var(--color-text-primary)]">
            Overrides
          </label>
          <div className="flex flex-wrap gap-2">
            {overrides.map((o, i) => (
              <span
                key={i}
                className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                  o.op === "+"
                    ? "bg-[var(--color-success)]/15 text-[var(--color-success)]"
                    : "bg-[var(--color-danger)]/15 text-[var(--color-danger)]"
                }`}
              >
                {o.op === "+" ? "+" : "\u2212"}{o.ext}
                <button
                  type="button"
                  onClick={() => handleRemove(i)}
                  className="ml-0.5 hover:opacity-70"
                >
                  &times;
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="mb-4 flex gap-2">
        <input
          type="text"
          value={newExt}
          onChange={(e) => setNewExt(e.target.value)}
          placeholder=".ext"
          className="w-32 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (newExt.trim()) handleAdd(newExt.trim(), "+");
            }
          }}
        />
        <Button
          size="sm"
          disabled={!newExt.trim() || updateOrg.isPending}
          onClick={() => handleAdd(newExt.trim(), "+")}
        >
          Add binary ext
        </Button>
        <Button
          size="sm"
          variant="danger"
          disabled={!newExt.trim() || updateOrg.isPending}
          onClick={() => handleAdd(newExt.trim(), "-")}
        >
          Remove default ext
        </Button>
      </div>

      <details className="text-sm">
        <summary className="cursor-pointer text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]">
          View resolved list ({data.resolved.length} extensions)
        </summary>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {data.resolved.map((ext) => (
            <span
              key={ext}
              className="rounded bg-[var(--color-bg-tertiary)] px-2 py-0.5 text-xs text-[var(--color-text-secondary)]"
            >
              {ext}
            </span>
          ))}
        </div>
      </details>
    </Card>
  );
}
