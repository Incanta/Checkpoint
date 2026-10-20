"use client";

import { Suspense, useState } from "react";
import { authClient } from "~/lib/auth-client";
import { useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { useDocumentTitle } from "~/app/_hooks/useDocumentTitle";
import { useTheme } from "~/app/_components/theme-provider";
import { api } from "~/trpc/react";

interface ProviderInfo {
  id: string;
  name: string;
}

interface ProvidersResponse {
  providers: ProviderInfo[];
  emailPassword: boolean;
  passkeys: boolean;
  registrationOpen: boolean;
  showNewsletter: boolean;
}

const inputClassName =
  "mt-1 block w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)] focus:ring-1 focus:ring-[var(--color-accent)]";

const secondaryButtonClassName =
  "flex w-full justify-center rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-overlay)] px-4 py-2 text-sm font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-border-default)] focus:ring-2 focus:ring-[var(--color-accent)] focus:ring-offset-2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50";

export default function SignInPage() {
  return (
    <Suspense>
      <SignInPageContent />
    </Suspense>
  );
}

function SignInPageContent() {
  useDocumentTitle("Sign In · Checkpoint VCS");
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [emailPassword, setEmailPassword] = useState(true);
  const [passkeys, setPasskeys] = useState(false);
  const [twoFactorStep, setTwoFactorStep] = useState(false);
  const [registrationOpen, setRegistrationOpen] = useState(true);
  const [showNewsletter, setShowNewsletter] = useState(false);
  const [subscribeNewsletter, setSubscribeNewsletter] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [isSignUp, setIsSignUp] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const searchParams = useSearchParams();
  const error = searchParams.get("error");
  const inviteToken = searchParams.get("invite");

  // When arriving from an invite link, validate the token and prefill/lock the
  // signup form to the invited email.
  const { data: invite } = api.invite.getByToken.useQuery(
    { token: inviteToken ?? "" },
    { enabled: !!inviteToken },
  );
  const inviteValid = invite?.valid === true;

  useEffect(() => {
    if (invite?.valid) {
      setIsSignUp(true);
      setEmail(invite.email);
      if (invite.displayName) {
        setName(invite.displayName);
      }
    }
  }, [invite]);

  useEffect(() => {
    const loadProviders = async () => {
      const res = await fetch("/api/auth/providers");
      if (res.ok) {
        const data = (await res.json()) as ProvidersResponse;
        setProviders(data.providers);
        setEmailPassword(data.emailPassword);
        setPasskeys(data.passkeys);
        setRegistrationOpen(data.registrationOpen);
        setShowNewsletter(data.showNewsletter);
      }
    };
    void loadProviders();
  }, []);

  const handleProviderSignIn = async (providerId: string) => {
    setIsLoading(true);
    try {
      // Enterprise IdPs registered through the generic OAuth plugin sign in
      // through the same social endpoint as Google.
      await authClient.signIn.social({
        provider: providerId,
        callbackURL: "/",
      });
    } catch (err) {
      console.error("Provider sign in error:", err);
    } finally {
      setIsLoading(false);
    }
  };

  const handlePasskeySignIn = async () => {
    setIsLoading(true);
    setAuthError(null);
    try {
      const result = await authClient.signIn.passkey();
      if (result?.error) {
        setAuthError(
          result.error.message ?? "Passkey sign in failed. Please try again.",
        );
      } else {
        window.location.href = "/";
        return;
      }
    } catch (err) {
      console.error("Passkey sign in error:", err);
      setAuthError("Passkey sign in failed. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleEmailSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setAuthError(null);

    try {
      if (isSignUp) {
        const { error } = await authClient.signUp.email({
          email,
          password,
          name,
          callbackURL: "/",
        });
        if (error) {
          setAuthError(error.message ?? "Sign up failed. Please try again.");
        } else {
          if (subscribeNewsletter && showNewsletter) {
            await fetch("/api/newsletter/subscribe", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ email, name }),
            });
          }

          window.location.href = "/";
          return;
        }
      } else {
        const { data, error } = await authClient.signIn.email({
          email,
          password,
          callbackURL: "/",
        });
        if (error) {
          setAuthError(error.message ?? "Invalid email or password.");
        } else if (data && "twoFactorRedirect" in data) {
          // No session yet: the account has TOTP, so ask for the code.
          setTwoFactorStep(true);
        } else {
          window.location.href = "/";
          return;
        }
      }
    } catch (err) {
      console.error("Email auth error:", err);
      setAuthError("An unexpected error occurred. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const getErrorMessage = (error: string | null) => {
    switch (error) {
      case "OAuthAccountNotLinked":
        return "This account is already linked to another provider. Please use the original sign-in method.";
      default:
        return error
          ? "An error occurred during sign in. Please try again."
          : null;
    }
  };

  const { theme, toggle } = useTheme();

  // Passkeys sign in to an existing account; signing up still needs a password.
  const showPasskey = passkeys && !isSignUp;

  return (
    <div className="relative w-full max-w-md space-y-8 rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] p-8">
      <button
        type="button"
        onClick={toggle}
        className="absolute top-4 right-4 rounded-md p-1.5 text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-overlay)] hover:text-[var(--color-text-primary)]"
        aria-label="Toggle theme"
      >
        {theme === "dark" ? (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2" />
            <path d="M12 20v2" />
            <path d="m4.93 4.93 1.41 1.41" />
            <path d="m17.66 17.66 1.41 1.41" />
            <path d="M2 12h2" />
            <path d="M20 12h2" />
            <path d="m6.34 17.66-1.41 1.41" />
            <path d="m19.07 4.93-1.41 1.41" />
          </svg>
        ) : (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
          </svg>
        )}
      </button>
      <div>
        <h2 className="text-center text-2xl font-semibold text-[var(--color-text-primary)]">
          Sign in to your account
        </h2>
      </div>

      {(error || authError) && (
        <div className="rounded-md border border-[var(--color-danger)] bg-[var(--color-danger)]/10 p-3">
          <p className="text-sm text-[var(--color-danger)]">
            {authError ?? getErrorMessage(error)}
          </p>
        </div>
      )}

      {inviteValid && (
        <div className="rounded-md border border-[var(--color-accent)] bg-[var(--color-accent)]/10 p-3">
          <p className="text-sm text-[var(--color-text-primary)]">
            You&apos;ve been invited to Checkpoint. Create your account below.
          </p>
        </div>
      )}

      {inviteToken && invite && !invite.valid && (
        <div className="rounded-md border border-[var(--color-danger)] bg-[var(--color-danger)]/10 p-3">
          <p className="text-sm text-[var(--color-danger)]">
            This invitation is no longer valid. It may have been revoked or
            already used.
          </p>
        </div>
      )}

      <div className="space-y-6">
        {twoFactorStep && (
          <TwoFactorStep
            onCancel={() => {
              setTwoFactorStep(false);
              setPassword("");
            }}
          />
        )}

        {/* Email & Password */}
        {emailPassword && !twoFactorStep && (
          <form onSubmit={handleEmailSignIn} className="space-y-4">
            {isSignUp && (
              <div>
                <label
                  htmlFor="name"
                  className="mb-1 block text-sm font-medium text-[var(--color-text-primary)]"
                >
                  Name
                </label>
                <input
                  id="name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  className="mt-1 block w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)] focus:ring-1 focus:ring-[var(--color-accent)]"
                  placeholder="Your name"
                />
              </div>
            )}
            <div>
              <label
                htmlFor="email"
                className="mb-1 block text-sm font-medium text-[var(--color-text-primary)]"
              >
                Email
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                readOnly={inviteValid}
                className={`mt-1 block w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)] focus:ring-1 focus:ring-[var(--color-accent)]${
                  inviteValid ? "cursor-not-allowed opacity-70" : ""
                }`}
                placeholder="you@example.com"
              />
            </div>
            <div>
              <label
                htmlFor="password"
                className="mb-1 block text-sm font-medium text-[var(--color-text-primary)]"
              >
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                className="mt-1 block w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)] focus:ring-1 focus:ring-[var(--color-accent)]"
                placeholder="••••••••"
              />
            </div>
            {isSignUp && showNewsletter && (
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={subscribeNewsletter}
                  onChange={(e) => setSubscribeNewsletter(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-600 bg-gray-800 text-[hsl(280,100%,70%)] focus:ring-[hsl(280,100%,70%)]"
                />
                <span className="text-sm text-gray-300">
                  Sign up for news and release updates
                </span>
              </label>
            )}
            <button
              type="submit"
              disabled={isLoading}
              className="flex w-full justify-center rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-accent-hover)] focus:ring-2 focus:ring-[var(--color-accent)] focus:ring-offset-2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSignUp ? "Sign up" : "Sign in"}
            </button>
            <p className="text-center text-sm text-[var(--color-text-secondary)]">
              {isSignUp ? "Already have an account?" : "Don't have an account?"}{" "}
              {registrationOpen || isSignUp || inviteValid ? (
                <button
                  type="button"
                  onClick={() => {
                    setIsSignUp(!isSignUp);
                    setAuthError(null);
                  }}
                  className="text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] hover:underline"
                >
                  {isSignUp ? "Sign in" : "Sign up"}
                </button>
              ) : (
                <span className="text-[var(--color-text-muted)]">
                  Registration is not yet available.
                </span>
              )}
            </p>
          </form>
        )}

        {!twoFactorStep && (
          <>
            {/* Divider */}
            {emailPassword && (providers.length > 0 || showPasskey) && (
              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-[var(--color-border-default)]" />
                </div>
                <div className="relative flex justify-center text-sm">
                  <span className="bg-[var(--color-bg-secondary)] px-2 text-[var(--color-text-muted)]">
                    Or continue with
                  </span>
                </div>
              </div>
            )}

            <div className="space-y-3">
              {showPasskey && (
                <button
                  type="button"
                  onClick={handlePasskeySignIn}
                  disabled={isLoading}
                  className={secondaryButtonClassName}
                >
                  Sign in with a passkey
                </button>
              )}

              {/* Identity providers */}
              {providers.map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  onClick={() => handleProviderSignIn(provider.id)}
                  disabled={isLoading}
                  className={secondaryButtonClassName}
                >
                  Sign in with {provider.name}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The second step of a password sign-in for an account with TOTP. The
 * password step left a short-lived two-factor cookie; verifying the code (or
 * a backup code) against it creates the session.
 */
function TwoFactorStep({ onCancel }: { onCancel: () => void }) {
  const [code, setCode] = useState("");
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [trustDevice, setTrustDevice] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);
    try {
      const { error } = useBackupCode
        ? await authClient.twoFactor.verifyBackupCode({
            code: code.trim(),
            trustDevice,
          })
        : await authClient.twoFactor.verifyTotp({
            code: code.replace(/\s/g, ""),
            trustDevice,
          });
      if (error) {
        setError(error.message ?? "That code didn't work. Please try again.");
      } else {
        window.location.href = "/";
        return;
      }
    } catch (err) {
      console.error("Two-factor verification error:", err);
      setError("An unexpected error occurred. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label
          htmlFor="two-factor-code"
          className="mb-1 block text-sm font-medium text-[var(--color-text-primary)]"
        >
          {useBackupCode ? "Backup code" : "Authentication code"}
        </label>
        <p className="text-sm text-[var(--color-text-secondary)]">
          {useBackupCode
            ? "Enter one of the backup codes you saved when you set up two-factor authentication. Each code works once."
            : "Enter the 6-digit code from your authenticator app."}
        </p>
        <input
          id="two-factor-code"
          type="text"
          inputMode={useBackupCode ? "text" : "numeric"}
          autoComplete="one-time-code"
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value)}
          required
          className={inputClassName}
          placeholder={useBackupCode ? "xxxxx-xxxxx" : "123456"}
        />
      </div>
      <label className="flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          checked={trustDevice}
          onChange={(e) => setTrustDevice(e.target.checked)}
          className="h-4 w-4 accent-[var(--color-accent)]"
        />
        <span className="text-sm text-[var(--color-text-secondary)]">
          Don&apos;t ask again on this device for 30 days
        </span>
      </label>
      {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}
      <button
        type="submit"
        disabled={isLoading}
        className="flex w-full justify-center rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-accent-hover)] focus:ring-2 focus:ring-[var(--color-accent)] focus:ring-offset-2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
      >
        Verify
      </button>
      <div className="flex justify-between text-sm">
        <button
          type="button"
          onClick={() => {
            setUseBackupCode(!useBackupCode);
            setCode("");
            setError(null);
          }}
          className="text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] hover:underline"
        >
          {useBackupCode ? "Use authenticator app" : "Use a backup code"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="text-[var(--color-text-secondary)] hover:underline"
        >
          Back to sign in
        </button>
      </div>
    </form>
  );
}
