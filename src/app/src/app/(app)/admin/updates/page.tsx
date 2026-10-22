"use client";

import { useState } from "react";
import { notFound } from "next/navigation";
import { api } from "~/trpc/react";
import { Badge, Button, Card, PageHeader } from "~/app/_components/ui";
import { useDocumentTitle } from "~/app/_hooks/useDocumentTitle";
import { AdminTabs } from "../_components/admin-tabs";

/**
 * Instance update panel.
 *
 * Deliberately a two-step flow: downloading a release is hundreds of megabytes
 * and can fail, so it happens while the current version keeps serving. Only
 * "Install" restarts anything, and by then the bundle is already on disk and
 * verified, so the outage is a process restart rather than a download.
 */

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <span className="text-sm text-[var(--color-text-secondary)]">
        {label}
      </span>
      <span className="text-sm text-[var(--color-text-primary)]">
        {children}
      </span>
    </div>
  );
}

function Mono({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <code className="rounded bg-[var(--color-bg-overlay)] px-1.5 py-0.5 font-mono text-xs">
      {children}
    </code>
  );
}

export default function AdminUpdatesPage(): React.ReactElement {
  useDocumentTitle("Updates");

  const [busy, setBusy] = useState<
    null | "check" | "download" | "install" | "rollback"
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  const { data: user, isLoading: userLoading } = api.user.me.useQuery();

  const status = api.updates.getStatus.useQuery(undefined, {
    enabled: !!user?.checkpointAdmin,
    // While a download is running the panel needs to move; otherwise this is
    // just keeping the restart state honest.
    refetchInterval: (query) =>
      query.state.data?.stage.state === "staging" ? 2000 : 30_000,
  });

  if (!userLoading && !user?.checkpointAdmin) {
    notFound();
  }

  const fail = (err: unknown): void => {
    setError(err instanceof Error ? err.message : String(err));
    setBusy(null);
  };

  const checkNow = api.updates.checkNow.useMutation({
    onSuccess: () => {
      setBusy(null);
      void status.refetch();
    },
    onError: fail,
  });
  const download = api.updates.download.useMutation({
    onSuccess: () => {
      setBusy(null);
      void status.refetch();
    },
    onError: fail,
  });
  const install = api.updates.install.useMutation({
    // The server exits ~2s after responding, so there is nothing to refetch:
    // the page stays on this message until the container is back.
    onError: fail,
  });
  const rollback = api.updates.rollback.useMutation({ onError: fail });

  const data = status.data;

  if (status.isLoading || !data) {
    return (
      <div>
        <PageHeader title="Updates" />
        <AdminTabs />
        <Card>
          <p className="text-sm text-[var(--color-text-secondary)]">Loading…</p>
        </Card>
      </div>
    );
  }

  const restarting = install.isSuccess || rollback.isSuccess;
  const staging = data.stage.state === "staging";
  const stageError = data.stage.state === "error" ? data.stage.message : null;
  const rollbackSafe =
    !!data.rollbackMigrations?.known &&
    data.rollbackMigrations.migrations.length === 0;

  return (
    <div>
      <PageHeader
        title="Updates"
        description="Keep this Checkpoint instance up to date."
      />
      <AdminTabs />

      {restarting && (
        <Card className="mb-4 border-[var(--color-accent)]">
          <p className="text-sm text-[var(--color-text-primary)]">
            Restarting onto{" "}
            <Mono>{install.data?.version ?? rollback.data?.version}</Mono>. This
            page will fail to load for a moment, then come back on the new
            version.
          </p>
        </Card>
      )}

      {(error ?? stageError) && (
        <Card className="mb-4 border-[var(--color-danger)]">
          <p className="text-sm text-[var(--color-danger)]">
            {error ?? stageError}
          </p>
        </Card>
      )}

      <Card className="mb-4">
        <h2 className="mb-2 text-base font-semibold text-[var(--color-text-primary)]">
          This instance
        </h2>
        <div className="divide-y divide-[var(--color-border-muted)]">
          <Row label="Running version">
            <Mono>{data.currentVersion}</Mono>
          </Row>
          <Row label="Channel">
            <Badge variant={data.channel === "nightly" ? "warning" : "default"}>
              {data.channel}
            </Badge>
          </Row>
          <Row label="Deployment">
            {data.bundleDeployment ? (
              <Badge variant={data.canInstall ? "success" : "info"}>
                {data.mode === "channel"
                  ? "bundle, following channel"
                  : data.mode === "pinned"
                    ? "bundle, pinned"
                    : "bundle, local file"}
              </Badge>
            ) : (
              <Badge variant="default">not a bundle deployment</Badge>
            )}
          </Row>
          {data.components.server && (
            <Row label="Core server">
              <Mono>{data.components.server.active}</Mono>
            </Row>
          )}
          {data.previousVersion && (
            <Row label="Previous version">
              <Mono>{data.previousVersion}</Mono>
            </Row>
          )}
        </div>
      </Card>

      <Card className="mb-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-base font-semibold text-[var(--color-text-primary)]">
            Available
          </h2>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy !== null || checkNow.isPending}
            onClick={() => {
              setError(null);
              setBusy("check");
              checkNow.mutate();
            }}
          >
            {checkNow.isPending ? "Checking…" : "Check now"}
          </Button>
        </div>

        {!data.checkEnabled && (
          <p className="mb-3 text-sm text-[var(--color-text-secondary)]">
            Update checks are disabled. Set <Mono>updates.enabled</Mono> to true
            in this instance&apos;s config to watch the {data.channel} channel.
          </p>
        )}

        {data.updateAvailable && data.latestVersion ? (
          <>
            <p className="mb-3 text-sm text-[var(--color-text-primary)]">
              <Mono>{data.latestVersion}</Mono> is available on the{" "}
              {data.channel} channel.
            </p>

            {!data.canInstall ? (
              <p className="text-sm text-[var(--color-text-secondary)]">
                {data.bundleDeployment
                  ? "This deployment is pinned, so its version is controlled by its configuration rather than from here."
                  : "This instance does not run from a deployment bundle, so it cannot update itself. Pull the new image instead."}
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  disabled={staging || data.staged || busy !== null}
                  onClick={() => {
                    setError(null);
                    setBusy("download");
                    download.mutate({
                      version: data.latestVersion!,
                      releaseTag: data.latestReleaseTag,
                    });
                  }}
                >
                  {staging
                    ? `Downloading ${data.stage.state === "staging" ? data.stage.component : ""}…`
                    : data.staged
                      ? "Downloaded"
                      : "Download"}
                </Button>

                <Button
                  variant="primary"
                  disabled={
                    !data.staged || staging || busy !== null || restarting
                  }
                  onClick={() => {
                    setError(null);
                    setBusy("install");
                    install.mutate({
                      version: data.latestVersion!,
                      releaseTag: data.latestReleaseTag,
                    });
                  }}
                >
                  Install and restart
                </Button>
              </div>
            )}

            {data.canInstall && !data.staged && !staging && (
              <p className="mt-3 text-xs text-[var(--color-text-muted)]">
                Downloading does not interrupt anything. The instance keeps
                running {data.currentVersion} until you install.
              </p>
            )}
          </>
        ) : (
          <p className="text-sm text-[var(--color-text-secondary)]">
            {data.latestVersion ? (
              <>
                Up to date. The {data.channel} channel is at{" "}
                <Mono>{data.latestVersion}</Mono>.
              </>
            ) : (
              "No release information available yet."
            )}
          </p>
        )}
      </Card>

      {data.canInstall && data.previousVersion && (
        <Card>
          <h2 className="mb-2 text-base font-semibold text-[var(--color-text-primary)]">
            Roll back
          </h2>
          <p className="mb-3 text-sm text-[var(--color-text-secondary)]">
            Return to <Mono>{data.previousVersion}</Mono>, which is still on
            disk. Database migrations are not reversed by a rollback.
          </p>

          {rollbackSafe ? (
            <p className="mb-3 text-sm text-[var(--color-success)]">
              The database has no migrations that{" "}
              <Mono>{data.previousVersion}</Mono> does not know about, so it is
              safe to roll back.
            </p>
          ) : (
            <div className="mb-3 text-sm text-[var(--color-danger)]">
              {data.rollbackMigrations?.known ? (
                <>
                  <p className="mb-2">
                    The database has applied{" "}
                    {data.rollbackMigrations.migrations.length === 1
                      ? "a migration"
                      : `${data.rollbackMigrations.migrations.length} migrations`}{" "}
                    that <Mono>{data.previousVersion}</Mono> does not know
                    about. Rolling back leaves them in place, and the older
                    version may fail against the changed schema. Restoring a
                    database backup taken before the update is the safe way
                    back.
                  </p>
                  <ul className="mb-2 list-disc pl-5">
                    {data.rollbackMigrations.migrations.map((name) => (
                      <li key={name}>
                        <Mono>{name}</Mono>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="mb-2">
                  Could not determine whether this version applied database
                  migrations. Roll back only if you know it did not.
                </p>
              )}
              <label className="flex items-center gap-2 text-[var(--color-text-primary)]">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                />
                I understand, roll back anyway
              </label>
            </div>
          )}

          <Button
            variant="danger"
            disabled={
              busy !== null || restarting || (!rollbackSafe && !acknowledged)
            }
            onClick={() => {
              setError(null);
              setBusy("rollback");
              rollback.mutate({ acknowledgeMigrations: !rollbackSafe });
            }}
          >
            Roll back and restart
          </Button>
        </Card>
      )}
    </div>
  );
}
