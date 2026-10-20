"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, type RouterOutputs } from "~/trpc/react";
import { Avatar, Badge, Button, Card } from "~/app/_components/ui";

type MfaReport = RouterOutputs["org"]["getMfaReport"];
type MfaReportEntry = MfaReport["entries"][number];

function describeRole(entry: MfaReportEntry): string {
  if (!entry.role) return "Repository collaborator";
  return entry.role === "ADMIN"
    ? "Admin"
    : entry.role === "BILLING"
      ? "Billing"
      : "Member";
}

function describeMethod(entry: MfaReportEntry): string {
  switch (entry.method) {
    case "totp":
      return "Password + authenticator app";
    case "passkey":
      return "Passkey only";
    case "identity-provider":
      return "Identity provider (MFA managed there)";
    case "api-only":
      return "API tokens only";
    default:
      return "Password without a second factor";
  }
}

function PeopleList({ entries }: { entries: MfaReportEntry[] }) {
  return (
    <ul className="max-h-72 divide-y divide-[var(--color-border-default)] overflow-y-auto rounded-md border border-[var(--color-border-default)]">
      {entries.map((entry) => (
        <li key={entry.userId} className="flex items-center gap-3 px-3 py-2">
          <Avatar
            src={entry.image}
            name={entry.name}
            email={entry.email}
            size="sm"
          />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm text-[var(--color-text-primary)]">
              {entry.name ?? entry.email}
            </div>
            <div className="truncate text-xs text-[var(--color-text-muted)]">
              {entry.name ? `${entry.email} · ` : ""}
              {describeRole(entry)} · {describeMethod(entry)}
            </div>
          </div>
          {!entry.compliant && <Badge variant="danger">No MFA</Badge>}
        </li>
      ))}
    </ul>
  );
}

/**
 * The org's "require two-factor authentication" setting. Enabling it locks
 * out everyone in the report's nonCompliant list, so the confirmation names
 * each of them and has to be acknowledged; once on, the card keeps listing
 * whoever is still locked out.
 */
export function RequireMfaCard({ orgId }: { orgId: string }) {
  const utils = api.useUtils();
  const { data: report } = api.org.getMfaReport.useQuery({ orgId });
  const [confirming, setConfirming] = useState<"enable" | "disable" | null>(
    null,
  );
  const [acknowledged, setAcknowledged] = useState(false);

  const setRequireMfa = api.org.setRequireMfa.useMutation({
    onSuccess: (updated) => {
      utils.org.getMfaReport.setData({ orgId }, updated);
      void utils.org.getOrg.invalidate();
      void utils.org.myOrgs.invalidate();
      setConfirming(null);
      setAcknowledged(false);
    },
  });

  useEffect(() => {
    if (!confirming) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConfirming(null);
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [confirming]);

  if (!report) return null;

  const nonCompliant = report.nonCompliant;
  const exemptViaIdp = report.entries.filter(
    (e) => e.method === "identity-provider",
  );
  const needsAck = confirming === "enable" && nonCompliant.length > 0;

  return (
    <Card>
      <div className="mb-1 flex items-center gap-2">
        <h3 className="text-lg font-semibold text-[var(--color-text-primary)]">
          Require two-factor authentication
        </h3>
        {report.requireMfa ? (
          <Badge variant="success">On</Badge>
        ) : (
          <Badge variant="default">Off</Badge>
        )}
      </div>
      <p className="mb-4 text-sm text-[var(--color-text-secondary)]">
        Members who sign in with a password must also use an authenticator app,
        or sign in with a passkey instead of a password. Members without it stay
        in the organization but can&apos;t see or change its repositories,
        billing, or settings (including from the desktop app and CI tokens)
        until they set it up. Public repositories stay readable to everyone.
      </p>

      {report.requireMfa ? (
        <div className="space-y-4">
          {nonCompliant.length > 0 ? (
            <div className="space-y-2">
              <p className="rounded-md border border-[var(--color-danger)] bg-[var(--color-danger)]/10 p-3 text-sm text-[var(--color-danger)]">
                {nonCompliant.length === 1
                  ? "1 person has"
                  : `${nonCompliant.length} people have`}{" "}
                lost access because they haven&apos;t set up two-factor
                authentication yet. They see a notice asking them to set it up
                in their security settings.
              </p>
              <PeopleList entries={nonCompliant} />
            </div>
          ) : (
            <p className="text-sm text-[var(--color-success)]">
              Everyone in this organization meets the requirement.
            </p>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setConfirming("disable")}
          >
            Stop requiring two-factor
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {nonCompliant.length > 0 && (
            <p className="text-sm text-[var(--color-warning)]">
              {nonCompliant.length === 1
                ? "1 person doesn't"
                : `${nonCompliant.length} people don't`}{" "}
              have two-factor authentication yet and would lose access.
            </p>
          )}
          {!report.viewerCompliant && (
            <p className="text-sm text-[var(--color-text-secondary)]">
              Set up two-factor authentication for your own account in{" "}
              <Link
                href="/settings/security"
                className="text-[var(--color-info)] hover:underline"
              >
                security settings
              </Link>{" "}
              before requiring it here.
            </p>
          )}
          <Button
            size="sm"
            disabled={!report.viewerCompliant}
            onClick={() => setConfirming("enable")}
          >
            Require two-factor…
          </Button>
        </div>
      )}

      {confirming && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setConfirming(null)}
        >
          <div
            className="w-full max-w-lg rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            {confirming === "enable" ? (
              <>
                <h3 className="mb-2 text-lg font-semibold text-[var(--color-text-primary)]">
                  Require two-factor authentication?
                </h3>
                {nonCompliant.length > 0 ? (
                  <div className="mb-4 space-y-3">
                    <p className="rounded-md border border-[var(--color-danger)] bg-[var(--color-danger)]/10 p-3 text-sm text-[var(--color-danger)]">
                      {nonCompliant.length === 1
                        ? "This person loses"
                        : `These ${nonCompliant.length} people lose`}{" "}
                      access to every repository in this organization right
                      away, including pulls and submits from the desktop app and
                      CI jobs using their tokens. They get it back as soon as
                      they set up two-factor authentication.
                    </p>
                    <PeopleList entries={nonCompliant} />
                    <label className="flex cursor-pointer items-start gap-2">
                      <input
                        type="checkbox"
                        checked={acknowledged}
                        onChange={(e) => setAcknowledged(e.target.checked)}
                        className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
                      />
                      <span className="text-sm text-[var(--color-text-primary)]">
                        I understand that{" "}
                        {nonCompliant.length === 1
                          ? "this person loses"
                          : `these ${nonCompliant.length} people lose`}{" "}
                        access until they set up two-factor authentication.
                      </span>
                    </label>
                  </div>
                ) : (
                  <p className="mb-4 text-sm text-[var(--color-text-secondary)]">
                    Everyone in this organization already meets the requirement,
                    so nobody loses access. Anyone who joins later, or turns
                    their authenticator off, will lose access until they set it
                    up.
                  </p>
                )}
                {exemptViaIdp.length > 0 && (
                  <p className="mb-4 text-xs text-[var(--color-text-muted)]">
                    {exemptViaIdp.length === 1
                      ? "1 person signs"
                      : `${exemptViaIdp.length} people sign`}{" "}
                    in only through an identity provider. Checkpoint can&apos;t
                    see their MFA, so they aren&apos;t blocked; enforce MFA in
                    the identity provider for them.
                  </p>
                )}
              </>
            ) : (
              <>
                <h3 className="mb-2 text-lg font-semibold text-[var(--color-text-primary)]">
                  Stop requiring two-factor authentication?
                </h3>
                <p className="mb-4 text-sm text-[var(--color-text-secondary)]">
                  {nonCompliant.length > 0
                    ? `The ${nonCompliant.length === 1 ? "person" : `${nonCompliant.length} people`} without it get their access back immediately. `
                    : ""}
                  Members who sign in with only a password will be able to
                  access this organization&apos;s repositories again.
                </p>
              </>
            )}

            {setRequireMfa.error && (
              <p className="mb-3 text-sm text-[var(--color-danger)]">
                {setRequireMfa.error.message}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirming(null)}>
                Cancel
              </Button>
              <Button
                variant={
                  confirming === "enable" && nonCompliant.length > 0
                    ? "danger"
                    : "primary"
                }
                disabled={
                  setRequireMfa.isPending || (needsAck && !acknowledged)
                }
                onClick={() =>
                  setRequireMfa.mutate({
                    orgId,
                    enabled: confirming === "enable",
                  })
                }
              >
                {confirming === "enable"
                  ? nonCompliant.length > 0
                    ? `Require it and block ${nonCompliant.length}`
                    : "Require two-factor"
                  : "Stop requiring it"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
