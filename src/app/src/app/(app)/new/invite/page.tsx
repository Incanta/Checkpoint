"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "~/trpc/react";
import { Button, Card, PageHeader, Badge } from "~/app/_components/ui";
import { useDocumentTitle } from "~/app/_hooks/useDocumentTitle";

type OrgGrant = { orgId: string; role: "MEMBER" | "BILLING" | "ADMIN" };
type RepoGrant = { repoId: string; access: "READ" | "WRITE" | "ADMIN" };

const STATUS_VARIANT = {
  PENDING: "warning" as const,
  ACCEPTED: "accent" as const,
  REVOKED: "default" as const,
};

export default function NewInvitePage() {
  useDocumentTitle("Invite user · Checkpoint VCS");
  const router = useRouter();
  const utils = api.useUtils();

  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [orgGrants, setOrgGrants] = useState<OrgGrant[]>([]);
  const [repoGrants, setRepoGrants] = useState<RepoGrant[]>([]);
  const [createdLink, setCreatedLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const { data: cap, isLoading: capLoading } = api.invite.canInvite.useQuery();
  const { data: targets } = api.invite.grantableTargets.useQuery(undefined, {
    enabled: cap?.canInvite === true,
  });
  const { data: invites } = api.invite.list.useQuery(undefined, {
    enabled: cap?.canInvite === true,
  });

  const createInvite = api.invite.create.useMutation({
    onSuccess: (res) => {
      setCreatedLink(res.signupUrl);
      setCopied(false);
      setEmail("");
      setDisplayName("");
      setUsername("");
      setOrgGrants([]);
      setRepoGrants([]);
      void utils.invite.list.invalidate();
    },
  });

  const revokeInvite = api.invite.revoke.useMutation({
    onSuccess: () => void utils.invite.list.invalidate(),
  });
  const resendInvite = api.invite.resend.useMutation();

  const toggleOrg = (orgId: string) => {
    setOrgGrants((prev) =>
      prev.some((g) => g.orgId === orgId)
        ? prev.filter((g) => g.orgId !== orgId)
        : [...prev, { orgId, role: "MEMBER" }],
    );
  };
  const setOrgRole = (orgId: string, role: OrgGrant["role"]) => {
    setOrgGrants((prev) =>
      prev.map((g) => (g.orgId === orgId ? { ...g, role } : g)),
    );
  };
  const toggleRepo = (repoId: string) => {
    setRepoGrants((prev) =>
      prev.some((g) => g.repoId === repoId)
        ? prev.filter((g) => g.repoId !== repoId)
        : [...prev, { repoId, access: "WRITE" }],
    );
  };
  const setRepoAccess = (repoId: string, access: RepoGrant["access"]) => {
    setRepoGrants((prev) =>
      prev.map((g) => (g.repoId === repoId ? { ...g, access } : g)),
    );
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    createInvite.mutate({
      email: email.trim(),
      displayName: displayName.trim() || undefined,
      username: username.trim() || undefined,
      orgRoles: orgGrants,
      repoRoles: repoGrants,
    });
  };

  const copyLink = async () => {
    if (!createdLink) return;
    try {
      await navigator.clipboard.writeText(createdLink);
      setCopied(true);
    } catch {
      // Clipboard may be unavailable; the link is still shown for manual copy.
    }
  };

  if (!capLoading && cap && !cap.canInvite) {
    return (
      <div className="mx-auto max-w-2xl">
        <PageHeader title="Invite user" />
        <Card>
          <p className="text-sm text-[var(--color-text-secondary)]">
            You do not have permission to invite users on this instance.
          </p>
          <div className="mt-4">
            <Button variant="secondary" onClick={() => router.push("/")}>
              Back
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  const hasOrgs = (targets?.orgs?.length ?? 0) > 0;
  const hasRepos = (targets?.repos?.length ?? 0) > 0;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        title="Invite user"
        description="Send an invitation to create an account on this instance."
      />

      <Card>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="invite-email"
              className="mb-1 block text-sm font-medium text-[var(--color-text-primary)]"
            >
              Email <span className="text-[var(--color-danger)]">*</span>
            </label>
            <input
              id="invite-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
              placeholder="user@example.com"
              className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)] focus:ring-1 focus:ring-[var(--color-accent)]"
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label
                htmlFor="invite-name"
                className="mb-1 block text-sm font-medium text-[var(--color-text-primary)]"
              >
                Display name{" "}
                <span className="text-[var(--color-text-muted)]">
                  (optional)
                </span>
              </label>
              <input
                id="invite-name"
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Jane Doe"
                className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)] focus:ring-1 focus:ring-[var(--color-accent)]"
              />
            </div>
            <div>
              <label
                htmlFor="invite-username"
                className="mb-1 block text-sm font-medium text-[var(--color-text-primary)]"
              >
                Username{" "}
                <span className="text-[var(--color-text-muted)]">
                  (optional)
                </span>
              </label>
              <input
                id="invite-username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="janedoe"
                className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)] focus:ring-1 focus:ring-[var(--color-accent)]"
              />
            </div>
          </div>

          {/* Optional initial access grants */}
          {(hasOrgs || hasRepos) && (
            <div className="space-y-4 rounded-md border border-[var(--color-border-default)] p-4">
              <p className="text-sm font-medium text-[var(--color-text-primary)]">
                Initial access{" "}
                <span className="text-[var(--color-text-muted)]">
                  (optional)
                </span>
              </p>

              {hasOrgs && (
                <div className="space-y-2">
                  <p className="text-xs font-semibold tracking-wide text-[var(--color-text-muted)] uppercase">
                    Organizations
                  </p>
                  {targets?.orgs.map((org) => {
                    const grant = orgGrants.find((g) => g.orgId === org.id);
                    return (
                      <div key={org.id} className="flex items-center gap-3">
                        <label className="flex flex-1 cursor-pointer items-center gap-2">
                          <input
                            type="checkbox"
                            checked={!!grant}
                            onChange={() => toggleOrg(org.id)}
                            className="h-4 w-4 rounded border-[var(--color-border-default)] text-[var(--color-accent)] focus:ring-[var(--color-accent)]"
                          />
                          <span className="text-sm text-[var(--color-text-primary)]">
                            {org.name}
                          </span>
                        </label>
                        {grant && (
                          <select
                            value={grant.role}
                            onChange={(e) =>
                              setOrgRole(
                                org.id,
                                e.target.value as OrgGrant["role"],
                              )
                            }
                            className="rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-2 py-1 text-xs text-[var(--color-text-primary)] outline-none"
                          >
                            <option value="MEMBER">Member</option>
                            <option value="BILLING">Billing</option>
                            <option value="ADMIN">Admin</option>
                          </select>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {hasRepos && (
                <div className="space-y-2">
                  <p className="text-xs font-semibold tracking-wide text-[var(--color-text-muted)] uppercase">
                    Repositories
                  </p>
                  {targets?.repos.map((repo) => {
                    const grant = repoGrants.find((g) => g.repoId === repo.id);
                    return (
                      <div key={repo.id} className="flex items-center gap-3">
                        <label className="flex flex-1 cursor-pointer items-center gap-2">
                          <input
                            type="checkbox"
                            checked={!!grant}
                            onChange={() => toggleRepo(repo.id)}
                            className="h-4 w-4 rounded border-[var(--color-border-default)] text-[var(--color-accent)] focus:ring-[var(--color-accent)]"
                          />
                          <span className="text-sm text-[var(--color-text-primary)]">
                            {repo.orgName}/{repo.name}
                          </span>
                        </label>
                        {grant && (
                          <select
                            value={grant.access}
                            onChange={(e) =>
                              setRepoAccess(
                                repo.id,
                                e.target.value as RepoGrant["access"],
                              )
                            }
                            className="rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-2 py-1 text-xs text-[var(--color-text-primary)] outline-none"
                          >
                            <option value="READ">Read</option>
                            <option value="WRITE">Write</option>
                            <option value="ADMIN">Admin</option>
                          </select>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {createInvite.error && (
            <p className="text-sm text-[var(--color-danger)]">
              {createInvite.error.message}
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
              disabled={!email.trim() || createInvite.isPending}
            >
              {createInvite.isPending ? "Sending..." : "Send invite"}
            </Button>
          </div>
        </form>
      </Card>

      {/* Created link (useful when email is not configured) */}
      {createdLink && (
        <Card>
          <h3 className="mb-2 text-sm font-semibold text-[var(--color-text-primary)]">
            Invite created
          </h3>
          <p className="mb-2 text-xs text-[var(--color-text-muted)]">
            Share this signup link with the invitee. If email is configured, it
            was also sent to them.
          </p>
          <div className="flex gap-2">
            <input
              readOnly
              value={createdLink}
              className="flex-1 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] outline-none"
            />
            <Button size="sm" variant="secondary" onClick={copyLink}>
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </Card>
      )}

      {/* Existing invites */}
      {invites && invites.length > 0 && (
        <Card padding={false}>
          <div className="border-b border-[var(--color-border-default)] px-4 py-3">
            <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
              Invitations
            </h3>
          </div>
          <div className="divide-y divide-[var(--color-border-default)]">
            {invites.map((inv) => (
              <div
                key={inv.id}
                className="flex items-start justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-[var(--color-text-primary)]">
                      {inv.displayName ? `${inv.displayName} · ` : ""}
                      {inv.email}
                    </span>
                    <Badge variant={STATUS_VARIANT[inv.status] ?? "default"}>
                      {inv.status}
                    </Badge>
                  </div>
                  {(inv.orgRoles.length > 0 || inv.repoRoles.length > 0) && (
                    <div className="mt-1 text-xs text-[var(--color-text-muted)]">
                      {inv.orgRoles
                        .map((r) => `${r.orgName} (${r.role})`)
                        .concat(
                          inv.repoRoles.map(
                            (r) => `${r.orgName}/${r.repoName} (${r.access})`,
                          ),
                        )
                        .join(", ")}
                    </div>
                  )}
                </div>
                {inv.status === "PENDING" && (
                  <div className="flex shrink-0 gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => resendInvite.mutate({ id: inv.id })}
                      disabled={resendInvite.isPending}
                    >
                      Resend
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => revokeInvite.mutate({ id: inv.id })}
                      disabled={revokeInvite.isPending}
                    >
                      Revoke
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
