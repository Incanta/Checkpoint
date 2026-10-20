"use client";

import { useCallback, useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { api, type RouterOutputs } from "~/trpc/react";
import { authClient } from "~/lib/auth-client";
import { Badge, Button, Card, PageHeader } from "~/app/_components/ui";
import { useDocumentTitle } from "~/app/_hooks/useDocumentTitle";

const inputClassName =
  "w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)] focus:ring-1 focus:ring-[var(--color-accent)]";

const PROVIDER_NAMES: Record<string, string> = {
  okta: "Okta",
  auth0: "Auth0",
  google: "Google",
  "microsoft-entra-id": "Microsoft Entra ID",
  keycloak: "Keycloak",
  oidc: "single sign-on",
};

export default function SecuritySettingsPage() {
  useDocumentTitle("Security · Checkpoint VCS");
  const { data: security, refetch } = api.user.security.useQuery();
  const utils = api.useUtils();

  const refresh = useCallback(() => {
    void refetch();
    // Org access depends on the result, so the sidebar and org pages too.
    void utils.org.myOrgs.invalidate();
    void utils.org.getOrg.invalidate();
  }, [refetch, utils]);

  if (!security) {
    return null;
  }

  const showPasskeys =
    security.passkeysEnabled &&
    (security.hasPassword || security.passkeyCount > 0);

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="Security"
        description="Manage how you sign in to Checkpoint."
      />

      <div className="space-y-6">
        {security.blockedOrgs.length > 0 && (
          <div className="rounded-md border border-[var(--color-danger)] bg-[var(--color-danger)]/10 p-4">
            <p className="text-sm font-medium text-[var(--color-danger)]">
              You can&apos;t access{" "}
              {security.blockedOrgs.map((o) => o.name).join(", ")} until you set
              up two-factor authentication.
            </p>
            <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
              {security.blockedOrgs.length === 1
                ? "This organization requires"
                : "These organizations require"}{" "}
              members who sign in with a password to also use an authenticator
              app. Set one up below, or add a passkey and remove your password.
            </p>
          </div>
        )}

        <SignInMethodsCard security={security} />

        {security.hasPassword && (
          <AuthenticatorCard
            enabled={security.twoFactorEnabled}
            orgsRequiringMfa={security.orgsRequiringMfa}
            onChange={refresh}
          />
        )}

        {showPasskeys && (
          <PasskeysCard
            canDeleteLast={
              security.hasPassword || security.identityProviders.length > 0
            }
            onChange={refresh}
          />
        )}

        {security.canRemovePassword && (
          <RemovePasswordCard
            orgsRequiringMfa={security.orgsRequiringMfa}
            onChange={refresh}
          />
        )}
      </div>
    </div>
  );
}

type Security = RouterOutputs["user"]["security"];

function SignInMethodsCard({ security }: { security: Security }) {
  return (
    <Card>
      <h3 className="mb-3 text-lg font-semibold text-[var(--color-text-primary)]">
        Sign-in methods
      </h3>
      <ul className="space-y-2 text-sm text-[var(--color-text-primary)]">
        {security.hasPassword && (
          <li className="flex items-center justify-between">
            <span>Password</span>
            {security.twoFactorEnabled ? (
              <Badge variant="success">With authenticator app</Badge>
            ) : (
              <Badge variant="warning">No second factor</Badge>
            )}
          </li>
        )}
        {security.passkeyCount > 0 && (
          <li className="flex items-center justify-between">
            <span>
              {security.passkeyCount === 1
                ? "1 passkey"
                : `${security.passkeyCount} passkeys`}
            </span>
          </li>
        )}
        {security.identityProviders.map((id) => (
          <li key={id} className="flex items-center justify-between">
            <span>{PROVIDER_NAMES[id] ?? id}</span>
            <span className="text-xs text-[var(--color-text-muted)]">
              MFA is managed by your identity provider
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function PasswordField({
  value,
  onChange,
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  id: string;
}) {
  return (
    <div>
      <label
        htmlFor={id}
        className="mb-1 block text-sm font-medium text-[var(--color-text-primary)]"
      >
        Current password
      </label>
      <input
        id={id}
        type="password"
        autoComplete="current-password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required
        className={inputClassName}
      />
    </div>
  );
}

function BackupCodes({ codes }: { codes: string[] }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-3">
      <p className="text-sm text-[var(--color-text-secondary)]">
        Save these backup codes somewhere safe. Each one signs you in once if
        you lose your authenticator. They won&apos;t be shown again.
      </p>
      <div className="grid grid-cols-2 gap-2 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] p-3 font-mono text-sm text-[var(--color-text-primary)]">
        {codes.map((code) => (
          <span key={code}>{code}</span>
        ))}
      </div>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(codes.join("\n"));
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          } catch {
            // Clipboard unavailable (insecure context); the codes stay
            // visible for manual copying.
          }
        }}
      >
        {copied ? "Copied!" : "Copy codes"}
      </Button>
    </div>
  );
}

type AuthenticatorStep =
  | { kind: "idle" }
  | { kind: "password"; action: "enable" | "disable" | "backup-codes" }
  | { kind: "scan"; totpURI: string; backupCodes: string[] }
  | { kind: "codes"; backupCodes: string[] };

function AuthenticatorCard({
  enabled,
  orgsRequiringMfa,
  onChange,
}: {
  enabled: boolean;
  orgsRequiringMfa: { id: string; name: string }[];
  onChange: () => void;
}) {
  const [step, setStep] = useState<AuthenticatorStep>({ kind: "idle" });
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const reset = () => {
    setStep({ kind: "idle" });
    setPassword("");
    setCode("");
    setError(null);
  };

  const handlePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (step.kind !== "password") return;
    setPending(true);
    setError(null);
    try {
      if (step.action === "enable") {
        const { data, error } = await authClient.twoFactor.enable({
          password,
          method: "totp",
        });
        if (error || data?.method !== "totp") {
          setError(error?.message ?? "Could not start setup.");
          return;
        }
        setStep({
          kind: "scan",
          totpURI: data.totpURI,
          backupCodes: data.backupCodes,
        });
      } else if (step.action === "disable") {
        const { error } = await authClient.twoFactor.disable({ password });
        if (error) {
          setError(error.message ?? "Could not turn off two-factor.");
          return;
        }
        reset();
        onChange();
      } else {
        const { data, error } = await authClient.twoFactor.generateBackupCodes({
          password,
        });
        if (error || !data) {
          setError(error?.message ?? "Could not generate new codes.");
          return;
        }
        setStep({ kind: "codes", backupCodes: data.backupCodes });
      }
      setPassword("");
    } finally {
      setPending(false);
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (step.kind !== "scan") return;
    setPending(true);
    setError(null);
    try {
      const { error } = await authClient.twoFactor.verifyTotp({
        code: code.replace(/\s/g, ""),
      });
      if (error) {
        setError(error.message ?? "That code didn't work. Please try again.");
        return;
      }
      setStep({ kind: "codes", backupCodes: step.backupCodes });
      setCode("");
      onChange();
    } finally {
      setPending(false);
    }
  };

  const secret =
    step.kind === "scan"
      ? new URL(step.totpURI).searchParams.get("secret")
      : null;

  return (
    <Card>
      <div className="mb-1 flex items-center gap-2">
        <h3 className="text-lg font-semibold text-[var(--color-text-primary)]">
          Authenticator app
        </h3>
        {enabled ? (
          <Badge variant="success">On</Badge>
        ) : (
          <Badge variant="default">Off</Badge>
        )}
      </div>
      <p className="mb-4 text-sm text-[var(--color-text-secondary)]">
        After your password, ask for a code from an authenticator app such as
        1Password, Google Authenticator, or Microsoft Authenticator.
      </p>

      {step.kind === "idle" && (
        <div className="flex gap-2">
          {enabled ? (
            <>
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  setStep({ kind: "password", action: "backup-codes" })
                }
              >
                New backup codes
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => setStep({ kind: "password", action: "disable" })}
              >
                Turn off
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              onClick={() => setStep({ kind: "password", action: "enable" })}
            >
              Set up authenticator app
            </Button>
          )}
        </div>
      )}

      {step.kind === "password" && (
        <form onSubmit={handlePassword} className="space-y-3">
          {step.action === "disable" && orgsRequiringMfa.length > 0 && (
            <p className="rounded-md border border-[var(--color-danger)] bg-[var(--color-danger)]/10 p-3 text-sm text-[var(--color-danger)]">
              {orgsRequiringMfa.map((o) => o.name).join(", ")}{" "}
              {orgsRequiringMfa.length === 1 ? "requires" : "require"}{" "}
              two-factor authentication. Turning it off removes your access to{" "}
              {orgsRequiringMfa.length === 1 ? "its" : "their"} repositories
              until you turn it back on.
            </p>
          )}
          {step.action === "backup-codes" && (
            <p className="text-sm text-[var(--color-text-secondary)]">
              New codes replace your current ones, which stop working.
            </p>
          )}
          <PasswordField
            id="totp-password"
            value={password}
            onChange={setPassword}
          />
          {error && (
            <p className="text-sm text-[var(--color-danger)]">{error}</p>
          )}
          <div className="flex gap-2">
            <Button
              type="submit"
              size="sm"
              variant={step.action === "disable" ? "danger" : "primary"}
              disabled={pending}
            >
              {step.action === "enable"
                ? "Continue"
                : step.action === "disable"
                  ? "Turn off two-factor"
                  : "Generate new codes"}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={reset}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {step.kind === "scan" && (
        <form onSubmit={handleVerify} className="space-y-4">
          <p className="text-sm text-[var(--color-text-secondary)]">
            Scan this QR code with your authenticator app, then enter the code
            it shows.
          </p>
          <div className="inline-block rounded-md bg-white p-3">
            <QRCodeSVG value={step.totpURI} size={176} />
          </div>
          {secret && (
            <p className="text-xs text-[var(--color-text-muted)]">
              Can&apos;t scan? Enter this key instead:{" "}
              <code className="font-mono break-all text-[var(--color-text-primary)]">
                {secret}
              </code>
            </p>
          )}
          <div>
            <label
              htmlFor="totp-verify"
              className="mb-1 block text-sm font-medium text-[var(--color-text-primary)]"
            >
              Code from the app
            </label>
            <input
              id="totp-verify"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              placeholder="123456"
              className={`${inputClassName} max-w-40`}
            />
          </div>
          {error && (
            <p className="text-sm text-[var(--color-danger)]">{error}</p>
          )}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={pending}>
              Turn on
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={reset}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {step.kind === "codes" && (
        <div className="space-y-3">
          <BackupCodes codes={step.backupCodes} />
          <Button size="sm" onClick={reset}>
            I&apos;ve saved them
          </Button>
        </div>
      )}
    </Card>
  );
}

interface PasskeyRow {
  id: string;
  name?: string | null;
  createdAt?: Date | string | null;
  deviceType: string;
}

function PasskeysCard({
  canDeleteLast,
  onChange,
}: {
  canDeleteLast: boolean;
  onChange: () => void;
}) {
  const [passkeys, setPasskeys] = useState<PasskeyRow[] | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const load = useCallback(async () => {
    const { data } = await authClient.passkey.listUserPasskeys();
    setPasskeys(data ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const result = await authClient.passkey.addPasskey({
        name: name.trim() || undefined,
      });
      if (result?.error) {
        setError(result.error.message ?? "Could not add the passkey.");
        return;
      }
      setName("");
      await load();
      onChange();
    } finally {
      setPending(false);
    }
  };

  const handleDelete = async (id: string) => {
    setError(null);
    const { error } = await authClient.passkey.deletePasskey({ id });
    if (error) {
      setError(error.message ?? "Could not delete the passkey.");
      return;
    }
    await load();
    onChange();
  };

  const onlyOne = (passkeys?.length ?? 0) <= 1;

  return (
    <Card>
      <h3 className="mb-1 text-lg font-semibold text-[var(--color-text-primary)]">
        Passkeys
      </h3>
      <p className="mb-4 text-sm text-[var(--color-text-secondary)]">
        Sign in with your device&apos;s fingerprint, face, or screen lock, or a
        security key, instead of typing a password.
      </p>

      {passkeys && passkeys.length > 0 && (
        <ul className="mb-4 divide-y divide-[var(--color-border-default)] rounded-md border border-[var(--color-border-default)]">
          {passkeys.map((pk) => (
            <li
              key={pk.id}
              className="flex items-center justify-between px-3 py-2 text-sm"
            >
              <div>
                <div className="text-[var(--color-text-primary)]">
                  {pk.name || "Passkey"}
                </div>
                {pk.createdAt && (
                  <div className="text-xs text-[var(--color-text-muted)]">
                    Added {new Date(pk.createdAt).toLocaleDateString()}
                  </div>
                )}
              </div>
              <Button
                variant="ghost"
                size="sm"
                disabled={!canDeleteLast && onlyOne}
                title={
                  !canDeleteLast && onlyOne
                    ? "This is your only way to sign in"
                    : undefined
                }
                onClick={() => void handleDelete(pk.id)}
              >
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={handleAdd} className="flex gap-2">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name (for example, Work laptop)"
          className={`${inputClassName} flex-1`}
        />
        <Button type="submit" size="sm" disabled={pending}>
          Add passkey
        </Button>
      </form>
      {error && (
        <p className="mt-2 text-sm text-[var(--color-danger)]">{error}</p>
      )}
    </Card>
  );
}

function RemovePasswordCard({
  orgsRequiringMfa,
  onChange,
}: {
  orgsRequiringMfa: { id: string; name: string }[];
  onChange: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const removePassword = api.user.removePassword.useMutation({
    onSuccess: () => {
      setOpen(false);
      setPassword("");
      onChange();
    },
  });

  return (
    <Card>
      <h3 className="mb-1 text-lg font-semibold text-[var(--color-text-primary)]">
        Go passwordless
      </h3>
      <p className="mb-4 text-sm text-[var(--color-text-secondary)]">
        Remove your password and sign in only with your passkeys
        {orgsRequiringMfa.length > 0
          ? ". This also meets your organizations' two-factor requirement."
          : "."}{" "}
        Your authenticator app is removed with it, since it only protects the
        password.
      </p>
      {!open ? (
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
          Remove password
        </Button>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            removePassword.mutate({ password });
          }}
          className="space-y-3"
        >
          <PasswordField
            id="remove-password"
            value={password}
            onChange={setPassword}
          />
          {removePassword.error && (
            <p className="text-sm text-[var(--color-danger)]">
              {removePassword.error.message}
            </p>
          )}
          <div className="flex gap-2">
            <Button
              type="submit"
              variant="danger"
              size="sm"
              disabled={removePassword.isPending}
            >
              Remove password
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
