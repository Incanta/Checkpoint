import config from "@incanta/config";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { db } from "~/server/db";
import { Logger } from "~/server/logging";

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

/**
 * Build the social providers config from YAML.
 * Each provider is only included if enabled in config.
 */
function buildSocialProviders() {
  const socialProviders: Record<string, Record<string, string>> = {};

  if (config.get<boolean>("auth.discord.enabled")) {
    socialProviders.discord = {
      clientId: config.get<string>("auth.discord.client.id"),
      clientSecret: config.get<string>("auth.discord.client.secret"),
    };
  }

  if (config.get<boolean>("auth.github.enabled")) {
    socialProviders.github = {
      clientId: config.get<string>("auth.github.client.id"),
      clientSecret: config.get<string>("auth.github.client.secret"),
    };
  }

  if (config.get<boolean>("auth.gitlab.enabled")) {
    socialProviders.gitlab = {
      clientId: config.get<string>("auth.gitlab.client.id"),
      clientSecret: config.get<string>("auth.gitlab.client.secret"),
    };
  }

  if (config.get<boolean>("auth.auth0.enabled")) {
    socialProviders.auth0 = {
      clientId: config.get<string>("auth.auth0.client.id"),
      clientSecret: config.get<string>("auth.auth0.client.secret"),
      issuer: config.get<string>("auth.auth0.issuer"),
    };
  }

  if (config.get<boolean>("auth.okta.enabled")) {
    socialProviders.okta = {
      clientId: config.get<string>("auth.okta.client.id"),
      clientSecret: config.get<string>("auth.okta.client.secret"),
      issuer: config.get<string>("auth.okta.issuer"),
    };
  }

  if (config.get<boolean>("auth.slack.enabled")) {
    socialProviders.slack = {
      clientId: config.get<string>("auth.slack.client.id"),
      clientSecret: config.get<string>("auth.slack.client.secret"),
    };
  }

  return socialProviders;
}

export const enabledProviderIds = (() => {
  const ids: string[] = [];
  const allProviders = [
    "discord",
    "github",
    "gitlab",
    "auth0",
    "okta",
    "slack",
  ];
  for (const p of allProviders) {
    if (config.get<boolean>(`auth.${p}.enabled`)) {
      ids.push(p);
    }
  }
  return ids;
})();

async function getAuth() {
  return betterAuth({
    baseURL: config.get<string>("server.external-url"),
    database: prismaAdapter(db, {
      provider: config.get<"sqlite" | "postgresql">("db.provider"),
    }),
    secret: await config.getWithSecrets<string>("auth.secret"),
    trustedOrigins: ["*"],
    emailAndPassword: {
      enabled: config.get<boolean>("auth.email-password.enabled"),
    },
    socialProviders: buildSocialProviders(),
    pages: {
      signIn: "/signin",
    },
    databaseHooks: {
      user: {
        create: {
          before: async (_user) => {
            const userCount = await db.user.count();
            if (userCount > 0) {
              const settings = await db.instanceSettings.findUnique({
                where: { id: "default" },
              });
              if (!settings?.eulaAcceptedAt) {
                return false;
              }
            }
            return undefined;
          },
          after: async (user) => {
            const userCount = await db.user.count();
            if (userCount === 1) {
              await db.user.update({
                where: { id: (user as { id: string }).id },
                data: { checkpointAdmin: true },
              });
              Logger.info(
                `[Auth] First user registered — granted checkpointAdmin to ${(user as { id: string }).id}`,
              );
            }
          },
        },
      },
    },
  });
}

export const auth = getAuth();
