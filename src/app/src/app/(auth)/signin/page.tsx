"use client";

import { Suspense, useState } from "react";
import { authClient } from "~/lib/auth-client";
import { useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { useDocumentTitle } from "~/app/_hooks/useDocumentTitle";
import { useTheme } from "~/app/_components/theme-provider";

interface ProviderInfo {
  id: string;
  name: string;
}

interface ProvidersResponse {
  providers: ProviderInfo[];
  registrationOpen: boolean;
}

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  discord: "Discord",
  github: "GitHub",
  gitlab: "GitLab",
  auth0: "Auth0",
  okta: "Okta",
  slack: "Slack",
};

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
  const [registrationOpen, setRegistrationOpen] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [isSignUp, setIsSignUp] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const searchParams = useSearchParams();
  const error = searchParams.get("error");

  useEffect(() => {
    const loadProviders = async () => {
      // Fetch enabled providers from our API
      const res = await fetch("/api/auth/providers");
      if (res.ok) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const data = (await res.json()) as ProvidersResponse;
        setProviders(data.providers);
        setRegistrationOpen(data.registrationOpen);
      }
    };
    void loadProviders();
  }, []);

  const handleProviderSignIn = async (providerId: string) => {
    setIsLoading(true);
    try {
      await authClient.signIn.social({
        provider: providerId as
          | "discord"
          | "github"
          | "gitlab"
          | "auth0"
          | "okta"
          | "slack",
        callbackURL: "/",
      });
    } catch (err) {
      console.error("Provider sign in error:", err);
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
          window.location.href = "/";
          return;
        }
      } else {
        const { error } = await authClient.signIn.email({
          email,
          password,
          callbackURL: "/",
        });
        if (error) {
          setAuthError(error.message ?? "Invalid email or password.");
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

      <div className="space-y-6">
        {/* Email & Password */}
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
              className="mt-1 block w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)] focus:ring-1 focus:ring-[var(--color-accent)]"
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
          <button
            type="submit"
            disabled={isLoading}
            className="flex w-full justify-center rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-accent-hover)] focus:ring-2 focus:ring-[var(--color-accent)] focus:ring-offset-2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSignUp ? "Sign up" : "Sign in"}
          </button>
          <p className="text-center text-sm text-[var(--color-text-secondary)]">
            {isSignUp ? "Already have an account?" : "Don't have an account?"}{" "}
            {registrationOpen || isSignUp ? (
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

        {/* Divider */}
        {providers.length > 0 && (
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

        {/* OAuth Providers */}
        {providers.length > 0 && (
          <div className="space-y-3">
            {providers.map((provider) => (
              <button
                key={provider.id}
                onClick={() => handleProviderSignIn(provider.id)}
                disabled={isLoading}
                className="flex w-full justify-center rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-overlay)] px-4 py-2 text-sm font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-border-default)] focus:ring-2 focus:ring-[var(--color-accent)] focus:ring-offset-2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
              >
                Sign in with {provider.name}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
