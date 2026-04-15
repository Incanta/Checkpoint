"use client";

import { useState } from "react";
import { useParams, notFound } from "next/navigation";
import { api } from "~/trpc/react";
import { useSession } from "~/lib/auth-client";
import { Button, Card, PageHeader, Badge } from "~/app/_components/ui";
import { useDocumentTitle } from "~/app/_hooks/useDocumentTitle";
import { SettingsTabs } from "../_components/settings-tabs";

export default function LicenseSettingsPage() {
  const params = useParams<{ orgName: string }>();
  const orgName = decodeURIComponent(params.orgName);
  useDocumentTitle(`License · ${orgName}`);
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
  if (org && !org.selfHosted) {
    notFound();
  }

  const { data: licenseInfo, isLoading } = api.license.getLicenseInfo.useQuery(
    { orgId: org?.id ?? "" },
    { enabled: !!org?.id },
  );

  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);

  const regenerate = api.license.regenerateSecret.useMutation({
    onSuccess: (data) => {
      setNewSecret(data.secret);
      setShowConfirm(false);
      void utils.license.getLicenseInfo.invalidate();
    },
  });

  const isAdmin = currentOrgUser?.role === "ADMIN";

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="License"
        description="Manage the self-hosted license for this organization."
      />
      <SettingsTabs orgName={orgName} />

      {isLoading && (
        <p className="text-sm text-[var(--color-text-muted)]">Loading…</p>
      )}

      {licenseInfo && (
        <div className="space-y-6">
          {/* License Key Card */}
          <Card>
            <h3 className="mb-4 text-sm font-semibold text-[var(--color-text-primary)]">
              License Credentials
            </h3>
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-[var(--color-text-muted)]">
                  License Key
                </label>
                <code className="block rounded bg-[var(--color-bg-tertiary)] px-3 py-2 text-sm text-[var(--color-text-primary)]">
                  {licenseInfo.key}
                </code>
                <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                  Use this key to identify your instance when configuring the
                  self-hosted Checkpoint server.
                </p>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-[var(--color-text-muted)]">
                  License Secret
                </label>
                {newSecret ? (
                  <div className="space-y-2">
                    <code className="block rounded border border-[var(--color-accent)] bg-[var(--color-accent)]/5 px-3 py-2 text-sm text-[var(--color-text-primary)]">
                      {newSecret}
                    </code>
                    <p className="text-xs font-medium text-[var(--color-warning)]">
                      Copy this secret now — it will not be shown again.
                    </p>
                    <Button
                      variant="secondary"
                      onClick={() => setNewSecret(null)}
                    >
                      Dismiss
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-sm text-[var(--color-text-secondary)]">
                      The license secret is hashed and cannot be retrieved. If
                      you&apos;ve lost it, regenerate a new one below.
                    </p>
                    {isAdmin && !showConfirm && (
                      <Button
                        variant="secondary"
                        onClick={() => setShowConfirm(true)}
                      >
                        Regenerate Secret
                      </Button>
                    )}
                    {showConfirm && (
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-[var(--color-danger)]">
                          This will invalidate the current secret.
                        </span>
                        <Button
                          variant="danger"
                          onClick={() => regenerate.mutate({ orgId: org!.id })}
                          disabled={regenerate.isPending}
                        >
                          {regenerate.isPending ? "Regenerating…" : "Confirm"}
                        </Button>
                        <Button
                          variant="secondary"
                          onClick={() => setShowConfirm(false)}
                        >
                          Cancel
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </Card>

          {/* License Status Card */}
          <Card>
            <h3 className="mb-4 text-sm font-semibold text-[var(--color-text-primary)]">
              License Status
            </h3>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-[var(--color-text-muted)]">Tier</span>
                <div className="mt-1">
                  <Badge
                    variant={
                      licenseInfo.tier === "STUDIO"
                        ? "accent"
                        : licenseInfo.tier === "PRO"
                          ? "info"
                          : "default"
                    }
                  >
                    {licenseInfo.tier}
                  </Badge>
                </div>
              </div>
              <div>
                <span className="text-[var(--color-text-muted)]">Status</span>
                <div className="mt-1">
                  <Badge variant={licenseInfo.active ? "success" : "danger"}>
                    {licenseInfo.active ? "Active" : "Inactive"}
                  </Badge>
                </div>
              </div>
              <div>
                <span className="text-[var(--color-text-muted)]">Created</span>
                <p className="mt-1 text-[var(--color-text-primary)]">
                  {new Date(licenseInfo.createdAt).toLocaleDateString()}
                </p>
              </div>
              <div>
                <span className="text-[var(--color-text-muted)]">
                  Last Report
                </span>
                <p className="mt-1 text-[var(--color-text-primary)]">
                  {licenseInfo.lastReportAt
                    ? new Date(licenseInfo.lastReportAt).toLocaleDateString()
                    : "Never"}
                </p>
              </div>
            </div>
          </Card>

          {/* Usage Reports Card */}
          <Card>
            <h3 className="mb-4 text-sm font-semibold text-[var(--color-text-primary)]">
              Usage Reports
            </h3>
            {licenseInfo.usageReports.length === 0 ? (
              <p className="text-sm text-[var(--color-text-muted)]">
                No usage reports received yet. Reports are sent automatically by
                the self-hosted instance.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-[var(--color-border-default)]">
                      <th className="pb-2 font-medium text-[var(--color-text-muted)]">
                        Period
                      </th>
                      <th className="pb-2 font-medium text-[var(--color-text-muted)]">
                        Write Users
                      </th>
                      <th className="pb-2 font-medium text-[var(--color-text-muted)]">
                        Read Users
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {licenseInfo.usageReports.map((report) => (
                      <tr
                        key={`${report.year}-${report.month}`}
                        className="border-b border-[var(--color-border-default)] last:border-none"
                      >
                        <td className="py-2 text-[var(--color-text-primary)]">
                          {new Date(
                            report.year,
                            report.month - 1,
                          ).toLocaleDateString(undefined, {
                            year: "numeric",
                            month: "long",
                          })}
                        </td>
                        <td className="py-2 text-[var(--color-text-primary)]">
                          {report.awuCount}
                        </td>
                        <td className="py-2 text-[var(--color-text-primary)]">
                          {report.aruCount}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* Configuration Guide */}
          <Card>
            <h3 className="mb-4 text-sm font-semibold text-[var(--color-text-primary)]">
              Configuration
            </h3>
            <p className="mb-3 text-sm text-[var(--color-text-secondary)]">
              Add the following to your self-hosted Checkpoint server&apos;s
              configuration:
            </p>
            <pre className="overflow-x-auto rounded bg-[var(--color-bg-tertiary)] p-3 text-xs text-[var(--color-text-primary)]">
              {`licensing:
  is-license-manager: false
  key: "${licenseInfo.key}"
  secret: "<your-license-secret>"
  manager-url: "${typeof window !== "undefined" ? window.location.origin : ""}"`.trim()}
            </pre>
          </Card>
        </div>
      )}

      {!isLoading && !licenseInfo && (
        <Card>
          <p className="text-sm text-[var(--color-text-muted)]">
            No license found for this organization.
          </p>
        </Card>
      )}
    </div>
  );
}
