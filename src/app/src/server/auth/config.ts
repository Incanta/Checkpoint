import config from "@incanta/config";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
} from "better-auth/api";
import { twoFactor } from "better-auth/plugins/two-factor";
import {
  auth0,
  genericOAuth,
  keycloak,
  microsoftEntraId,
  okta,
  type GenericOAuthConfig,
} from "better-auth/plugins/generic-oauth";
import { passkey } from "@better-auth/passkey";
import { db } from "~/server/db";
import { emailPasswordEnabled, passkeysEnabled } from "./methods";
import { authSecret } from "~/server/auth-secret";
import { Logger } from "~/server/logging";
import {
  consumeInvite,
  findValidInviteByEmail,
  getInviteMode,
} from "~/server/invites";

/**
 * Session type used throughout the app for compatibility.
 * Maps the better-auth session shape to a simpler interface.
 */
export interface Session {
  user: {
    id: string;
    name?: string | null;
    email?: string | null;
    image?: string | null;
  };
  expires: string;
}

export interface IdentityProvider {
  id: string;
  name: string;
}

function clientConfig(key: string) {
  return {
    clientId: config.get<string>(`auth.${key}.client.id`),
    clientSecret: config.get<string>(`auth.${key}.client.secret`),
  };
}

/**
 * The enterprise identity providers enabled in auth.yaml, as generic OAuth
 * (OIDC) configs. Google Workspace is a built-in social provider instead, see
 * buildSocialProviders.
 */
function buildOAuthProviders(): GenericOAuthConfig[] {
  const providers: GenericOAuthConfig[] = [];

  if (config.get<boolean>("auth.okta.enabled")) {
    providers.push(
      okta({
        ...clientConfig("okta"),
        issuer: config.get<string>("auth.okta.issuer"),
      }),
    );
  }

  if (config.get<boolean>("auth.auth0.enabled")) {
    providers.push(
      auth0({
        ...clientConfig("auth0"),
        domain: config.get<string>("auth.auth0.issuer"),
      }),
    );
  }

  if (config.get<boolean>("auth.microsoft-entra-id.enabled")) {
    providers.push(
      microsoftEntraId({
        ...clientConfig("microsoft-entra-id"),
        tenantId: config.get<string>("auth.microsoft-entra-id.tenant-id"),
      }),
    );
  }

  if (config.get<boolean>("auth.keycloak.enabled")) {
    providers.push(
      keycloak({
        ...clientConfig("keycloak"),
        issuer: config.get<string>("auth.keycloak.issuer"),
      }),
    );
  }

  if (config.get<boolean>("auth.oidc.enabled")) {
    providers.push({
      providerId: "oidc",
      name: config.get<string>("auth.oidc.name"),
      ...clientConfig("oidc"),
      discoveryUrl: config.get<string>("auth.oidc.discovery-url"),
      scopes: config.get<string[]>("auth.oidc.scopes"),
      pkce: config.get<boolean>("auth.oidc.pkce"),
    });
  }

  return providers;
}

function buildSocialProviders() {
  if (!config.get<boolean>("auth.google.enabled")) {
    return {};
  }

  const hostedDomain = config.get<string>("auth.google.hosted-domain");
  return {
    google: {
      ...clientConfig("google"),
      // better-auth checks the returned token's `hd` claim against this, so
      // it is a real restriction and not only an account-picker hint.
      ...(hostedDomain ? { hd: hostedDomain } : {}),
    },
  };
}

const PROVIDER_NAMES: Record<string, string> = {
  okta: "Okta",
  auth0: "Auth0",
  google: "Google",
  "microsoft-entra-id": "Microsoft",
  keycloak: "Keycloak",
};

/** Sign-in buttons for the enabled identity providers, in auth.yaml order. */
export const enabledIdentityProviders: IdentityProvider[] = [
  ...buildOAuthProviders().map((p) => ({
    id: p.providerId,
    name: p.name ?? PROVIDER_NAMES[p.providerId] ?? p.providerId,
  })),
  ...Object.keys(buildSocialProviders()).map((id) => ({
    id,
    name: PROVIDER_NAMES[id] ?? id,
  })),
];

/**
 * Guards on the passkey endpoints:
 *
 * - Registering: passkeys are Checkpoint's own credentials, so they are for
 *   accounts that already have Checkpoint credentials (a password or another
 *   passkey). A user who signs in only through an identity provider must not
 *   be able to add a way in that keeps working after the provider disables
 *   them.
 * - Deleting: a user without a password or identity provider must keep at
 *   least one passkey, or they could never sign in again.
 */
const passkeyGuard = createAuthMiddleware(async (ctx) => {
  const registering = ctx.path === "/passkey/generate-register-options";
  const deleting = ctx.path === "/passkey/delete-passkey";
  if (!registering && !deleting) {
    return;
  }

  const session = await getSessionFromCtx(ctx);
  if (!session) {
    return;
  }

  const userId = session.user.id;
  const [credential, otherAccount, passkeyCount] = await Promise.all([
    db.account.findFirst({
      where: { userId, providerId: "credential", password: { not: null } },
      select: { id: true },
    }),
    db.account.findFirst({
      where: { userId, providerId: { not: "credential" } },
      select: { id: true },
    }),
    db.passkey.count({ where: { userId } }),
  ]);

  if (registering && !credential && passkeyCount === 0) {
    throw new APIError("FORBIDDEN", {
      message:
        "Passkeys are only for accounts with a Checkpoint password. Your identity provider manages how you sign in.",
    });
  }

  if (deleting && !credential && !otherAccount && passkeyCount <= 1) {
    throw new APIError("BAD_REQUEST", {
      message:
        "This is your only way to sign in. Add another passkey before deleting this one.",
    });
  }
});

function serverOrigin(): URL {
  return new URL(config.get<string>("server.external-url"));
}

async function getAuth() {
  const oauthProviders = buildOAuthProviders();

  return betterAuth({
    appName: "Checkpoint",
    baseURL: config.get<string>("server.external-url"),
    database: prismaAdapter(db, {
      provider: config.get<"sqlite" | "postgresql">("db.provider"),
    }),
    secret: await authSecret(),
    trustedOrigins: ["*"],
    emailAndPassword: {
      enabled: emailPasswordEnabled(),
    },
    socialProviders: buildSocialProviders(),
    plugins: [
      // TOTP only gates password sign-in; identity-provider sign-ins skip it.
      twoFactor({ issuer: "Checkpoint" }),
      ...(passkeysEnabled()
        ? [
            passkey({
              rpID: serverOrigin().hostname,
              rpName: "Checkpoint",
              origin: serverOrigin().origin,
            }),
          ]
        : []),
      ...(oauthProviders.length > 0
        ? [genericOAuth({ config: oauthProviders })]
        : []),
    ],
    hooks: {
      before: passkeyGuard,
    },
    pages: {
      signIn: "/signin",
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const userCount = await db.user.count();
            // The very first account always registers (it bootstraps the
            // instance and becomes the checkpointAdmin below).
            if (userCount === 0) {
              return undefined;
            }

            const settings = await db.instanceSettings.findUnique({
              where: { id: "default" },
            });
            // Registration stays closed until initial setup is completed.
            if (!settings?.setupCompletedAt) {
              return false;
            }

            const mode = getInviteMode();
            if (mode === "public") {
              return undefined;
            }

            // "member"/"admin": registration requires a matching, valid invite.
            const email = (user as { email?: string }).email;
            const invite = email
              ? await findValidInviteByEmail(db, email)
              : null;
            if (!invite) {
              return false;
            }
            return undefined;
          },
          after: async (user) => {
            const { id: userId, email } = user as {
              id: string;
              email?: string;
            };

            const userCount = await db.user.count();
            if (userCount === 1) {
              await db.user.update({
                where: { id: userId },
                data: { checkpointAdmin: true },
              });
              Logger.info(
                `[Auth] First user registered, granted checkpointAdmin to ${userId}`,
              );
            }

            // Materialize any pending access grants from a matching invite.
            if (email) {
              const invite = await findValidInviteByEmail(db, email);
              if (invite) {
                await consumeInvite(db, invite.id, userId);
                Logger.info(
                  `[Auth] Consumed invite ${invite.id} for user ${userId}`,
                );
              }
            }
          },
        },
      },
    },
  });
}

export const auth = getAuth();
// Imported at build time too, when no auth secret is configured. Whoever
// awaits it still gets the error; instrumentation.ts reports it at startup.
auth.catch(() => undefined);
