"use client";

import { authClient } from "~/lib/auth-client";

export function SignOutButton() {
  const handleSignOut = async () => {
    await authClient.signOut({
      fetchOptions: {
        onSuccess: () => {
          window.location.href = "/signin";
        },
      },
    });
  };

  return (
    <button
      onClick={handleSignOut}
      className="rounded-full bg-white/10 px-6 py-2 font-semibold no-underline transition hover:bg-white/20"
    >
      Sign out
    </button>
  );
}
