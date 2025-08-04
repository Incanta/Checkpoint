import config from "@incanta/config";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { type DefaultSession, type NextAuthConfig } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import Auth0Provider from "next-auth/providers/auth0";
import GitHubProvider from "next-auth/providers/github";
import GitLabProvider from "next-auth/providers/gitlab";
import OktaProvider from "next-auth/providers/okta";
import SlackProvider from "next-auth/providers/slack";
import DiscordProvider from "next-auth/providers/discord";

import { db } from "~/server/db";
import { computePasswordHash } from "./credentials";
import type { Provider } from "next-auth/providers";

/**
 * Module augmentation for `next-auth` types. Allows us to add custom properties to the `session`
 * object and keep type safety.
 *
 * @see https://next-auth.js.org/getting-started/typescript#module-augmentation
 */
declare module "next-auth" {
  interface Session extends DefaultSession {
    user: {
      id: string;
      // ...other properties
      // role: UserRole;
    } & DefaultSession["user"];
  }

  // interface User {
  //   // ...other properties
  //   // role: UserRole;
  // }
}

const credentialsProvider = CredentialsProvider({
      name: "Credentials",
      credentials: {
        username: { label: "Username", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const user = await db.user.findUnique({
          where: { username: credentials?.username as string | undefined ?? "" },
        });

        if (user?.salt && user.hash) {
          const hash = await computePasswordHash(
            credentials?.password as string | undefined ?? "",
            user.salt as string
          );

          if (hash === user.hash) {
            return user;
          }
        }

        return null;
      },
    });

const auth0Provider = Auth0Provider({
  clientId: config.get<string>("auth.auth0.client.id"),
  clientSecret: config.get<string>("auth.auth0.client.secret"),
  issuer: config.get<string>("auth.auth0.issuer"),
});

const githubProvider = GitHubProvider({
  clientId: config.get<string>("auth.github.client.id"),
  clientSecret: config.get<string>("auth.github.client.secret"),
});

const gitlabProvider = GitLabProvider({
  clientId: config.get<string>("auth.gitlab.client.id"),
  clientSecret: config.get<string>("auth.gitlab.client.secret"),
});

const oktaProvider = OktaProvider({
  clientId: config.get<string>("auth.okta.client.id"),
  clientSecret: config.get<string>("auth.okta.client.secret"),
  issuer: config.get<string>("auth.okta.issuer"),
});

const slackProvider = SlackProvider({
  clientId: config.get<string>("auth.slack.client.id"),
  clientSecret: config.get<string>("auth.slack.client.secret"),
});

const discordProvider = DiscordProvider({
  clientId: config.get<string>("auth.discord.client.id"),
  clientSecret: config.get<string>("auth.discord.client.secret"),
});

const providers: Provider[] = [];

if (config.get<boolean>("auth.credentials.enabled")) {
  providers.push(credentialsProvider);
}

if (config.get<boolean>("auth.auth0.enabled")) {
  providers.push(auth0Provider);
}

if (config.get<boolean>("auth.github.enabled")) {
  providers.push(githubProvider);
}

if (config.get<boolean>("auth.gitlab.enabled")) {
  providers.push(gitlabProvider);
}

if (config.get<boolean>("auth.okta.enabled")) {
  providers.push(oktaProvider);
}

if (config.get<boolean>("auth.slack.enabled")) {
  providers.push(slackProvider);
}

if (config.get<boolean>("auth.discord.enabled")) {
  providers.push(discordProvider);
}

/**
 * Options for NextAuth.js used to configure adapters, providers, callbacks, etc.
 *
 * @see https://next-auth.js.org/configuration/options
 */
export const authConfig = {
  secret: config.get<string>("auth.jwt.secret"),
  providers,
  adapter: PrismaAdapter(db),
  callbacks: {
    session: ({ session, user }) => ({
      ...session,
      user: {
        ...session.user,
        id: user.id,
      },
    }),
  },
} satisfies NextAuthConfig;
