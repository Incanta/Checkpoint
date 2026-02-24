import config from "@incanta/config";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { type DefaultSession, type NextAuthConfig } from "next-auth";
import Auth0Provider from "next-auth/providers/auth0";
import KeycloakProvider from "next-auth/providers/keycloak";
import GitHubProvider from "next-auth/providers/github";
import GitLabProvider from "next-auth/providers/gitlab";
import OktaProvider from "next-auth/providers/okta";
import SlackProvider from "next-auth/providers/slack";
import DiscordProvider from "next-auth/providers/discord";

import { db } from "~/server/db";
import type { Provider } from "next-auth/providers";
import type { DefaultJWT } from "next-auth/jwt";

export interface Session extends DefaultSession {
  user: {
    id: string;
    // username: string;
  } & DefaultSession["user"];
}

/**
 * Module augmentation for `next-auth` types. Allows us to add custom properties to the `session`
 * object and keep type safety.
 *
 * @see https://next-auth.js.org/getting-started/typescript#module-augmentation
 */
declare module "next-auth" {
  interface JWT extends DefaultJWT {
    id: string;
    // username: string;
  }

  interface Session extends DefaultSession {
    user: {
      id: string;
      // username: string;
    } & DefaultSession["user"];
  }

  interface User {
    id?: string;
    // username: string;
  }
}

const providers: Provider[] = [];

if (config.get<boolean>("auth.auth0.enabled")) {
  const auth0Provider = Auth0Provider({
    clientId: config.get<string>("auth.auth0.client.id"),
    clientSecret: config.get<string>("auth.auth0.client.secret"),
    issuer: config.get<string>("auth.auth0.issuer"),
  });

  providers.push(auth0Provider);
}

if (config.get<boolean>("auth.keycloak.enabled")) {
  const keycloakProvider = KeycloakProvider({
    clientId: config.get<string>("auth.keycloak.client.id"),
    clientSecret: config.get<string>("auth.keycloak.client.secret"),
    issuer: config.get<string>("auth.keycloak.issuer"),
  });

  providers.push(keycloakProvider);
}

if (config.get<boolean>("auth.github.enabled")) {
  const githubProvider = GitHubProvider({
    clientId: config.get<string>("auth.github.client.id"),
    clientSecret: config.get<string>("auth.github.client.secret"),
  });

  providers.push(githubProvider);
}

if (config.get<boolean>("auth.gitlab.enabled")) {
  const gitlabProvider = GitLabProvider({
    clientId: config.get<string>("auth.gitlab.client.id"),
    clientSecret: config.get<string>("auth.gitlab.client.secret"),
  });

  providers.push(gitlabProvider);
}

if (config.get<boolean>("auth.okta.enabled")) {
  const oktaProvider = OktaProvider({
    clientId: config.get<string>("auth.okta.client.id"),
    clientSecret: config.get<string>("auth.okta.client.secret"),
    issuer: config.get<string>("auth.okta.issuer"),
  });

  providers.push(oktaProvider);
}

if (config.get<boolean>("auth.slack.enabled")) {
  const slackProvider = SlackProvider({
    clientId: config.get<string>("auth.slack.client.id"),
    clientSecret: config.get<string>("auth.slack.client.secret"),
  });

  providers.push(slackProvider);
}

if (config.get<boolean>("auth.discord.enabled")) {
  const discordProvider = DiscordProvider({
    clientId: config.get<string>("auth.discord.client.id"),
    clientSecret: config.get<string>("auth.discord.client.secret"),
  });

  providers.push(discordProvider);
}

/**
 * Options for NextAuth.js used to configure adapters, providers, callbacks, etc.
 *
 * @see https://next-auth.js.org/configuration/options
 */
export const authConfig: NextAuthConfig = {
  trustHost: true,
  secret: config.get<string>("auth.jwt.secret"),
  providers,
  adapter: PrismaAdapter(db),
  pages: {
    signIn: "/signin",
  },
} satisfies NextAuthConfig;
