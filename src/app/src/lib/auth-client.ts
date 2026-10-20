import { createAuthClient } from "better-auth/react";
import { twoFactorClient } from "better-auth/client/plugins";
import { passkeyClient } from "@better-auth/passkey/client";

export const authClient = createAuthClient({
  plugins: [
    // A password sign-in for an account with TOTP stops at the second-factor
    // step instead of creating a session; the sign-in page asks for the code.
    twoFactorClient(),
    passkeyClient(),
  ],
});

export const { signIn, signOut, useSession } = authClient;
