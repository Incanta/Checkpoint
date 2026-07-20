"use client";

import { useState } from "react";
import { useParams, useRouter, notFound } from "next/navigation";
import { api } from "~/trpc/react";
import { Button, Card, Badge } from "~/app/_components/ui";
import { useDocumentTitle } from "~/app/_hooks/useDocumentTitle";
import { useLicenseTier } from "~/app/_hooks/use-license-tier";
import { DeleteEntityModal } from "~/app/_components/delete-entity-modal";

function MergePermissionList({
  repoId,
  type,
  label,
}: {
  repoId: string;
  type: "MAINLINE" | "RELEASE";
  label: string;
}) {
  const utils = api.useUtils();
  const { data: permissions } = api.repo.getMergePermissions.useQuery({
    repoId,
  });
  const setPermissions = api.repo.setMergePermissions.useMutation({
    onSuccess: () => void utils.repo.getMergePermissions.invalidate(),
  });

  const current = permissions?.filter((p) => p.type === type) ?? [];
  const [newEmail, setNewEmail] = useState("");

  const handleAdd = () => {
    const email = newEmail.trim();
    if (!email) return;
    const emails = [...current.map((p) => p.user.email), email];
    setPermissions.mutate({ repoId, type, userEmails: emails });
    setNewEmail("");
  };

  const handleRemove = (emailToRemove: string) => {
    const emails = current
      .map((p) => p.user.email)
      .filter((e) => e !== emailToRemove);
    setPermissions.mutate({ repoId, type, userEmails: emails });
  };

  return (
    <div>
      <label className="mb-2 block text-sm font-medium text-[var(--color-text-primary)]">
        {label}
      </label>
      <p className="mb-2 text-xs text-[var(--color-text-muted)]">
        If empty, all members with write access can merge.
      </p>
      <div className="space-y-1.5">
        {current.map((p) => (
          <div key={p.id} className="flex items-center gap-2">
            <span className="text-sm text-[var(--color-text-primary)]">
              {p.user.name ?? p.user.email}
            </span>
            <span className="text-xs text-[var(--color-text-muted)]">
              {p.user.email}
            </span>
            <button
              type="button"
              onClick={() => handleRemove(p.user.email)}
              className="ml-auto text-xs text-[var(--color-danger)] hover:underline"
            >
              Remove
            </button>
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        <input
          type="email"
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          onKeyDown={(e) =>
            e.key === "Enter" && (e.preventDefault(), handleAdd())
          }
          placeholder="user@example.com"
          className="flex-1 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)]"
        />
        <Button size="sm" onClick={handleAdd} disabled={!newEmail.trim()}>
          Add
        </Button>
      </div>
      {setPermissions.error && (
        <p className="mt-1 text-xs text-[var(--color-danger)]">
          {setPermissions.error.message}
        </p>
      )}
    </div>
  );
}

const INPUT_CLASS =
  "w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)]";

const ISSUE_PLATFORMS = [
  { value: "CHECKPOINT", label: "Checkpoint" },
  { value: "JIRA", label: "Jira" },
  { value: "CODECKS", label: "Codecks" },
  { value: "HACKNPLAN", label: "HacknPlan" },
  { value: "DISABLED", label: "Disabled" },
] as const;

type IssuePlatformValue = (typeof ISSUE_PLATFORMS)[number]["value"];

function IssueTrackerCard({ repoId }: { repoId: string }) {
  const utils = api.useUtils();
  const { data: config } = api.issueTracker.getConfig.useQuery({ repoId });

  const [platform, setPlatform] = useState<IssuePlatformValue>("CHECKPOINT");
  const [jiraBaseUrl, setJiraBaseUrl] = useState("");
  const [jiraEmail, setJiraEmail] = useState("");
  const [jiraProjectKey, setJiraProjectKey] = useState("");
  const [codecksSubdomain, setCodecksSubdomain] = useState("");
  const [hacknplanProjectId, setHacknplanProjectId] = useState("");
  const [token, setToken] = useState("");
  const [initialized, setInitialized] = useState(false);

  if (config && !initialized) {
    setPlatform(config.platform);
    setJiraBaseUrl(config.jiraBaseUrl ?? "");
    setJiraEmail(config.jiraEmail ?? "");
    setJiraProjectKey(config.jiraProjectKey ?? "");
    setCodecksSubdomain(config.codecksSubdomain ?? "");
    setHacknplanProjectId(
      config.hacknplanProjectId ? String(config.hacknplanProjectId) : "",
    );
    setInitialized(true);
  }

  const updateConfig = api.issueTracker.updateConfig.useMutation({
    onSuccess: () => {
      setToken("");
      void utils.org.getOrg.invalidate();
      void utils.issueTracker.getConfig.invalidate();
      void utils.issueTracker.getLinkInfo.invalidate();
    },
  });
  const testConnection = api.issueTracker.testConnection.useMutation();

  const isExternal =
    platform === "JIRA" || platform === "CODECKS" || platform === "HACKNPLAN";
  // A saved token only counts for the platform it was saved under
  const hasSavedToken =
    !!config?.hasToken && (!config || platform === config.platform);
  const tokenLabel = platform === "HACKNPLAN" ? "API key" : "API token";

  const handleSave = () => {
    updateConfig.mutate({
      repoId,
      platform,
      jiraBaseUrl:
        platform === "JIRA" ? jiraBaseUrl.trim() || undefined : undefined,
      jiraEmail:
        platform === "JIRA" ? jiraEmail.trim() || undefined : undefined,
      jiraProjectKey:
        platform === "JIRA" ? jiraProjectKey.trim() || undefined : undefined,
      codecksSubdomain:
        platform === "CODECKS"
          ? codecksSubdomain.trim() || undefined
          : undefined,
      hacknplanProjectId:
        platform === "HACKNPLAN"
          ? parseInt(hacknplanProjectId) || undefined
          : undefined,
      token: token.trim() || undefined,
    });
  };

  return (
    <Card>
      <h3 className="mb-4 text-sm font-semibold text-[var(--color-text-primary)]">
        Issues
      </h3>
      <div className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium text-[var(--color-text-primary)]">
            Issues platform
          </label>
          <p className="mb-1.5 text-xs text-[var(--color-text-muted)]">
            Where issues for this repository are tracked. External platforms
            show a read-only list that links to the tracker, and issue mentions
            like #123 in pull requests and changelists link there too.
          </p>
          <select
            value={platform}
            onChange={(e) => setPlatform(e.target.value as IssuePlatformValue)}
            className={INPUT_CLASS}
          >
            {ISSUE_PLATFORMS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>

        {platform === "JIRA" && (
          <>
            <div>
              <label className="mb-1 block text-sm font-medium text-[var(--color-text-primary)]">
                Jira base URL
              </label>
              <input
                type="url"
                value={jiraBaseUrl}
                onChange={(e) => setJiraBaseUrl(e.target.value)}
                placeholder="https://your-site.atlassian.net"
                className={INPUT_CLASS}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-[var(--color-text-primary)]">
                Account email
              </label>
              <input
                type="email"
                value={jiraEmail}
                onChange={(e) => setJiraEmail(e.target.value)}
                placeholder="you@example.com"
                className={INPUT_CLASS}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-[var(--color-text-primary)]">
                Project key
              </label>
              <input
                type="text"
                value={jiraProjectKey}
                onChange={(e) => setJiraProjectKey(e.target.value)}
                placeholder="PROJ"
                className={INPUT_CLASS}
              />
            </div>
          </>
        )}

        {platform === "CODECKS" && (
          <div>
            <label className="mb-1 block text-sm font-medium text-[var(--color-text-primary)]">
              Codecks subdomain
            </label>
            <p className="mb-1.5 text-xs text-[var(--color-text-muted)]">
              The subdomain of your Codecks account, e.g. &quot;your-team&quot;
              for your-team.codecks.io.
            </p>
            <input
              type="text"
              value={codecksSubdomain}
              onChange={(e) => setCodecksSubdomain(e.target.value)}
              placeholder="your-team"
              className={INPUT_CLASS}
            />
          </div>
        )}

        {platform === "HACKNPLAN" && (
          <div>
            <label className="mb-1 block text-sm font-medium text-[var(--color-text-primary)]">
              Project ID
            </label>
            <input
              type="number"
              min={1}
              value={hacknplanProjectId}
              onChange={(e) => setHacknplanProjectId(e.target.value)}
              placeholder="12345"
              className={INPUT_CLASS}
            />
          </div>
        )}

        {isExternal && (
          <div>
            <label className="mb-1 block text-sm font-medium text-[var(--color-text-primary)]">
              {tokenLabel}
            </label>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={
                hasSavedToken
                  ? "•••••••• (saved, leave blank to keep)"
                  : `Enter ${tokenLabel}`
              }
              autoComplete="off"
              className={INPUT_CLASS}
            />
          </div>
        )}

        {updateConfig.error && (
          <p className="text-sm text-[var(--color-danger)]">
            {updateConfig.error.message}
          </p>
        )}
        {updateConfig.isSuccess && !updateConfig.isPending && (
          <p className="text-sm text-[var(--color-success)]">
            Issue settings saved.
          </p>
        )}
        {testConnection.data && (
          <p
            className={
              testConnection.data.ok
                ? "text-sm text-[var(--color-success)]"
                : "text-sm text-[var(--color-danger)]"
            }
          >
            {testConnection.data.ok
              ? `Connection succeeded (${testConnection.data.count} issues found).`
              : testConnection.data.message}
          </p>
        )}

        <div className="flex justify-end gap-2">
          {isExternal && config?.platform === platform && (
            <Button
              size="sm"
              variant="secondary"
              disabled={testConnection.isPending}
              onClick={() => testConnection.mutate({ repoId })}
            >
              {testConnection.isPending ? "Testing..." : "Test connection"}
            </Button>
          )}
          <Button
            size="sm"
            disabled={updateConfig.isPending}
            onClick={handleSave}
          >
            {updateConfig.isPending ? "Saving..." : "Save issue settings"}
          </Button>
        </div>
      </div>
    </Card>
  );
}

export default function RepoSettingsPage() {
  const params = useParams<{ orgName: string; repoName: string }>();
  const orgName = decodeURIComponent(params.orgName);
  const repoName = decodeURIComponent(params.repoName);
  useDocumentTitle(`Settings · ${repoName} in ${orgName}`);
  const router = useRouter();
  const utils = api.useUtils();

  const { data: org } = api.org.getOrg.useQuery({
    id: orgName,
    idIsName: true,
  });
  const repoData = org?.repos?.find(
    (r: { name: string }) => r.name === repoName,
  );

  const { data: access } = api.repo.getMyRepoAccess.useQuery(
    { repoId: repoData?.id ?? "" },
    { enabled: !!repoData?.id },
  );

  if (access && !access.isAdmin) {
    notFound();
  }

  const { hasFeature } = useLicenseTier(org?.id);
  const showPrSettings = hasFeature("pullRequests");
  const showIssueSettings = hasFeature("issues");

  const [name, setName] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [requiredReviews, setRequiredReviews] = useState(0);
  const [mergePermissionsSame, setMergePermissionsSame] = useState(true);
  const [initialized, setInitialized] = useState(false);

  if (repoData && !initialized) {
    setName(repoData.name);
    setIsPublic(repoData.public);
    setRequiredReviews(repoData.requiredReviews ?? 0);
    setMergePermissionsSame(repoData.mergePermissionsSame ?? true);
    setInitialized(true);
  }

  const updateRepo = api.repo.updateRepo.useMutation({
    onSuccess: (updated) => {
      void utils.org.myOrgs.invalidate();
      void utils.org.getOrg.invalidate();
      if (updated.name !== repoName) {
        router.replace(`/${orgName}/${updated.name}/settings`);
      }
    },
  });

  const { data: checkoutSettings } = api.billing.getCheckoutSettings.useQuery();

  const deleteRepo = api.repo.deleteRepo.useMutation({
    onSuccess: () => {
      void utils.org.myOrgs.invalidate();
      router.push(`/${orgName}`);
    },
  });

  const [showDelete, setShowDelete] = useState(false);

  return (
    <div className="space-y-6">
      <Card>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!repoData) return;
            updateRepo.mutate({
              id: repoData.id,
              name: name.trim() || undefined,
              // public: isPublic,
              requiredReviews,
              mergePermissionsSame,
            });
          }}
          className="space-y-4"
        >
          <div>
            <label className="mb-1 block text-sm font-medium text-[var(--color-text-primary)]">
              Repository name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)] focus:ring-1 focus:ring-[var(--color-accent)]"
            />
          </div>

          {/* <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="repo-public"
              checked={isPublic}
              onChange={(e) => setIsPublic(e.target.checked)}
              className="h-4 w-4 accent-[var(--color-accent)]"
            />
            <label
              htmlFor="repo-public"
              className="text-sm text-[var(--color-text-primary)]"
            >
              Public repository
            </label>
          </div> */}

          {updateRepo.error && (
            <p className="text-sm text-[var(--color-danger)]">
              {updateRepo.error.message}
            </p>
          )}
          {updateRepo.isSuccess && (
            <p className="text-sm text-[var(--color-success)]">
              Settings saved.
            </p>
          )}

          <div className="flex justify-end">
            <Button type="submit" disabled={updateRepo.isPending}>
              {updateRepo.isPending ? "Saving..." : "Save changes"}
            </Button>
          </div>
        </form>
      </Card>

      {/* Pull Request / Merge settings (Pro+ only) */}
      {showPrSettings && (
        <>
          <Card>
            <h3 className="mb-4 text-sm font-semibold text-[var(--color-text-primary)]">
              Pull request settings
            </h3>
            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-[var(--color-text-primary)]">
                  Required approving reviews
                </label>
                <p className="mb-1.5 text-xs text-[var(--color-text-muted)]">
                  Minimum number of approvals before a pull request can be
                  merged. Set to 0 to allow merging without reviews.
                </p>
                <input
                  type="number"
                  min={0}
                  value={requiredReviews}
                  onChange={(e) =>
                    setRequiredReviews(
                      Math.max(0, parseInt(e.target.value) || 0),
                    )
                  }
                  className="w-20 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
                />
              </div>

              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  id="merge-same"
                  checked={mergePermissionsSame}
                  onChange={(e) => setMergePermissionsSame(e.target.checked)}
                  className="h-4 w-4 accent-[var(--color-accent)]"
                />
                <label
                  htmlFor="merge-same"
                  className="text-sm text-[var(--color-text-primary)]"
                >
                  Use the same merge permissions for Mainline and Release
                  branches
                </label>
              </div>

              <div className="flex justify-end">
                <Button
                  size="sm"
                  disabled={updateRepo.isPending}
                  onClick={() => {
                    if (!repoData) return;
                    updateRepo.mutate({
                      id: repoData.id,
                      requiredReviews,
                      mergePermissionsSame,
                    });
                  }}
                >
                  {updateRepo.isPending ? "Saving..." : "Save PR settings"}
                </Button>
              </div>
            </div>
          </Card>

          {/* Merge permissions */}
          {repoData && (
            <Card>
              <h3 className="mb-4 text-sm font-semibold text-[var(--color-text-primary)]">
                Merge permissions
              </h3>
              <div className="space-y-6">
                <MergePermissionList
                  repoId={repoData.id}
                  type="MAINLINE"
                  label={
                    mergePermissionsSame
                      ? "Authorized mergers"
                      : "Mainline branch mergers"
                  }
                />
                {!mergePermissionsSame && (
                  <MergePermissionList
                    repoId={repoData.id}
                    type="RELEASE"
                    label="Release branch mergers"
                  />
                )}
              </div>
            </Card>
          )}
        </>
      )}

      {/* Issue tracker settings (Pro+ only) */}
      {showIssueSettings && repoData && (
        <IssueTrackerCard repoId={repoData.id} />
      )}

      {/* Danger zone */}
      <Card className="border-[var(--color-danger)]/30">
        <h3 className="mb-3 text-lg font-semibold text-[var(--color-danger)]">
          Danger zone
        </h3>
        <Button variant="danger" size="sm" onClick={() => setShowDelete(true)}>
          Delete this repository
        </Button>
      </Card>

      {showDelete && repoData && (
        <DeleteEntityModal
          kind="repo"
          orgName={orgName}
          repoName={repoName}
          repoId={repoData.id}
          isPending={deleteRepo.isPending}
          onClose={() => setShowDelete(false)}
          onConfirm={() => deleteRepo.mutate({ id: repoData.id })}
          extraWarning={
            checkoutSettings?.enabled ? (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
                <p className="text-xs text-amber-400">
                  <strong>Storage billing note:</strong> Storage used by this
                  repository will continue to count toward your current billing
                  period&apos;s peak usage. Storage cleanup will begin shortly
                  after deletion.
                </p>
              </div>
            ) : undefined
          }
        />
      )}
    </div>
  );
}
