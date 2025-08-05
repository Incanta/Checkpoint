"use client";

import { useState } from "react";
import { signIn, getProviders } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useEffect } from "react";

interface Provider {
  id: string;
  name: string;
  type: string;
}

export default function SignInPage() {
  const [providers, setProviders] = useState<Record<string, Provider> | null>(
    null,
  );
  const [isLoading, setIsLoading] = useState(false);
  const [credentials, setCredentials] = useState({
    username: "",
    password: "",
  });
  const searchParams = useSearchParams();
  const error = searchParams.get("error");

  useEffect(() => {
    const loadProviders = async () => {
      const res = await getProviders();
      setProviders(res as Record<string, Provider> | null);
    };
    void loadProviders();
  }, []);

  const handleCredentialsSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      await signIn("credentials", {
        username: credentials.username,
        password: credentials.password,
        callbackUrl: "/",
      });
    } catch (error) {
      console.error("Sign in error:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleProviderSignIn = async (providerId: string) => {
    setIsLoading(true);
    try {
      await signIn(providerId, { callbackUrl: "/" });
    } catch (error) {
      console.error("Provider sign in error:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const getErrorMessage = (error: string | null) => {
    switch (error) {
      case "CredentialsSignin":
        return "Invalid username or password. Please try again.";
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
          <p className="mt-2 text-center text-sm text-gray-300">
            Or{" "}
            <Link
              href="/register"
              className="font-medium text-[hsl(280,100%,70%)] hover:text-[hsl(280,100%,80%)]"
            >
              create a new account
            </Link>
          </p>
        </div>

        {error && (
          <div className="rounded-md border border-red-700 bg-red-900/50 p-3">
            <p className="text-sm text-red-200">{getErrorMessage(error)}</p>
          </div>
        )}

        <div className="space-y-6">
          {/* Credentials Form */}
          {providers?.credentials && (
            <form onSubmit={handleCredentialsSignIn} className="space-y-4">
              <div>
                <label
                  htmlFor="username"
                  className="block text-sm font-medium text-gray-300"
                >
                  Username
                </label>
                <input
                  id="username"
                  name="username"
                  type="text"
                  autoComplete="username"
                  required
                  className="relative block w-full appearance-none rounded-md border border-gray-600 bg-gray-800 px-3 py-2 text-white placeholder-gray-400 focus:z-10 focus:border-[hsl(280,100%,70%)] focus:outline-none focus:ring-[hsl(280,100%,70%)] sm:text-sm"
                  placeholder="Enter your username"
                  value={credentials.username}
                  onChange={(e) =>
                    setCredentials((prev) => ({
                      ...prev,
                      username: e.target.value,
                    }))
                  }
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
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  className="relative block w-full appearance-none rounded-md border border-gray-600 bg-gray-800 px-3 py-2 text-white placeholder-gray-400 focus:z-10 focus:border-[hsl(280,100%,70%)] focus:outline-none focus:ring-[hsl(280,100%,70%)] sm:text-sm"
                  placeholder="Enter your password"
                  value={credentials.password}
                  onChange={(e) =>
                    setCredentials((prev) => ({
                      ...prev,
                      password: e.target.value,
                    }))
                  }
                />
              </div>

              <button
                type="submit"
                disabled={isLoading}
                className="group relative flex w-full justify-center rounded-md border border-transparent bg-[hsl(280,100%,70%)] px-4 py-2 text-sm font-medium text-white hover:bg-[hsl(280,100%,60%)] focus:outline-none focus:ring-2 focus:ring-[hsl(280,100%,70%)] focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isLoading ? "Signing in..." : "Sign in"}
              </button>
            </form>
          )}

          {/* OAuth Providers */}
          {providers &&
            Object.values(providers).some(
              (provider) => provider.id !== "credentials",
            ) && (
              <div className="space-y-3">
                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-gray-600" />
                  </div>
                  <div className="relative flex justify-center text-sm">
                    <span className="bg-gradient-to-b from-[#2e026d] to-[#15162c] px-2 text-gray-400">
                      Or continue with
                    </span>
                  </div>
                </div>

                {Object.values(providers).map((provider) => {
                  if (provider.id === "credentials") return null;

                  return (
                    <button
                      key={provider.id}
                      onClick={() => handleProviderSignIn(provider.id)}
                      disabled={isLoading}
                      className="group relative flex w-full justify-center rounded-md border border-gray-600 bg-gray-800 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-[hsl(280,100%,70%)] focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Sign in with {provider.name}
                    </button>
                  );
                })}
              </div>
            )}
        </div>
      </div>
    </div>
  );
}
