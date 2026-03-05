"use client";

import { useState } from "react";
import { authClient } from "~/lib/auth-client";
import { useSearchParams } from "next/navigation";
import { useEffect } from "react";

interface ProviderInfo {
  id: string;
  name: string;
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
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
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
        const data: ProviderInfo[] = await res.json();
        setProviders(data);
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
        }
      } else {
        const { error } = await authClient.signIn.email({
          email,
          password,
          callbackURL: "/",
        });
        if (error) {
          setAuthError(error.message ?? "Invalid email or password.");
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

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-[#2e026d] to-[#15162c] px-4 py-12 sm:px-6 lg:px-8">
      <div className="w-full max-w-md space-y-8">
        <div>
          <h2 className="mt-6 text-center text-3xl font-extrabold text-white">
            Sign in to your account
          </h2>
        </div>

        {(error || authError) && (
          <div className="rounded-md border border-red-700 bg-red-900/50 p-3">
            <p className="text-sm text-red-200">
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
                  className="block text-sm font-medium text-gray-300"
                >
                  Name
                </label>
                <input
                  id="name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  className="mt-1 block w-full rounded-md border border-gray-600 bg-gray-800 px-3 py-2 text-white placeholder-gray-400 focus:border-[hsl(280,100%,70%)] focus:ring-[hsl(280,100%,70%)] focus:outline-none"
                  placeholder="Your name"
                />
              </div>
            )}
            <div>
              <label
                htmlFor="email"
                className="block text-sm font-medium text-gray-300"
              >
                Email
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="mt-1 block w-full rounded-md border border-gray-600 bg-gray-800 px-3 py-2 text-white placeholder-gray-400 focus:border-[hsl(280,100%,70%)] focus:ring-[hsl(280,100%,70%)] focus:outline-none"
                placeholder="you@example.com"
              />
            </div>
            <div>
              <label
                htmlFor="password"
                className="block text-sm font-medium text-gray-300"
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
                className="mt-1 block w-full rounded-md border border-gray-600 bg-gray-800 px-3 py-2 text-white placeholder-gray-400 focus:border-[hsl(280,100%,70%)] focus:ring-[hsl(280,100%,70%)] focus:outline-none"
                placeholder="••••••••"
              />
            </div>
            <button
              type="submit"
              disabled={isLoading}
              className="group relative flex w-full justify-center rounded-md bg-[hsl(280,100%,70%)] px-4 py-2 text-sm font-medium text-white hover:bg-[hsl(280,100%,60%)] focus:ring-2 focus:ring-[hsl(280,100%,70%)] focus:ring-offset-2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSignUp ? "Sign up" : "Sign in"}
            </button>
            <p className="text-center text-sm text-gray-400">
              {isSignUp ? "Already have an account?" : "Don't have an account?"}{" "}
              <button
                type="button"
                onClick={() => {
                  setIsSignUp(!isSignUp);
                  setAuthError(null);
                }}
                className="text-[hsl(280,100%,70%)] hover:underline"
              >
                {isSignUp ? "Sign in" : "Sign up"}
              </button>
            </p>
          </form>

          {/* Divider */}
          {providers.length > 0 && (
            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-gray-600" />
              </div>
              <div className="relative flex justify-center text-sm">
                <span className="bg-[#15162c] px-2 text-gray-400">
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
                  className="group relative flex w-full justify-center rounded-md border border-gray-600 bg-gray-800 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 focus:ring-2 focus:ring-[hsl(280,100%,70%)] focus:ring-offset-2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Sign in with {provider.name}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
