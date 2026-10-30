---
sidebar_position: 6
---

# Authentication

This page covers how people sign in to a self-hosted Checkpoint instance: the auth secret, who may register, email and password accounts, second factors, enterprise identity providers, and how the desktop app, CLI, and CI get their credentials.

All settings live in the app's `auth.yaml`. With the Docker Compose bundle, put the keys you want to change in `config/app/auth.yaml`; it is merged on top of the defaults in [`src/app/config/default/auth.yaml`](https://github.com/Incanta/Checkpoint/blob/main/src/app/config/default/auth.yaml), so you only list what differs. Restart the app after changing it (`docker compose restart app`). See [Configuration](./configuration.md) for how config files and secret references work.

## The auth secret (required)

The app signs session cookies with `auth.secret`. Anyone who knows it can sign in as anyone, so it has no default and the app refuses to start without a good one. It must:

- be at least 32 characters long,
- not be a well-known placeholder (such as `changeme` or the old default), and
- have some variety in it (at least 8 distinct characters).

Generate one with:

```bash
openssl rand -hex 32
```

Set it in one of two ways. The environment variable wins when both are set.

- `auth.secret` in `auth.yaml`. A secret reference works here; the Docker Compose bundle ships `secret: "secret|betterauth_secret"`, which reads `betterauth_secret` from `config/.secrets`.
- The `CHECKPOINT_AUTH_SECRET` environment variable.

If it is missing or weak, the app logs an error like this and exits:

```text
Refusing to sign sessions: no auth secret is configured. Set CHECKPOINT_AUTH_SECRET (or auth.secret) to a random value of at least 32 characters. For example: openssl rand -hex 32
```

:::warning Changing the secret
Changing `auth.secret` signs everyone out of the web app. Unless `security.encryption-key` is set, it also changes the key that encrypts stored integration secrets (such as issue tracker tokens), and those have to be re-entered. Set `security.encryption-key` (32 random bytes, base64, for example `openssl rand -base64 32`) if you expect to rotate the auth secret. API tokens used by the desktop app, CLI, and CI are stored in the database and are not affected.
:::

## First sign-in and initial setup

The first account registered on a new instance always succeeds, whatever the sign-up policy. That account becomes the **instance admin** (see [Organizations and access](./organizations-and-access.md)) and is sent to a one-time **Welcome to Checkpoint** setup page, which asks whether to share anonymous usage metrics.

Nobody else can register until that setup page has been completed. Until then, the sign-in page shows "Registration is not yet available."

## Who may register: `invite-only`

`invite-only` controls who can create an account after the first one.

| Value | Who can register | Who can create invitations |
| --- | --- | --- |
| `"admin"` (default) | Only people with a valid invitation | Only the instance admin |
| `"member"` | Only people with a valid invitation | Any signed-in user |
| `"public"` | Anyone who can reach the sign-in page | Any signed-in user |

```yaml
invite-only: "admin" # "public" | "member" | "admin"
```

An unknown value is treated as `"admin"`.

With `"admin"` or `"member"`, an account can only be created for an email address that has a pending, unexpired invitation. This applies to every sign-in method, including identity providers: the first time someone signs in through Okta, Entra ID, or another provider, the email the provider returns must match a pending invitation, or the account is not created. Email matching ignores case. See [Inviting people](./organizations-and-access.md#inviting-people) for how to create invitations.

:::caution
For a beta team, keep the default `"admin"`. With `"public"`, anyone who can reach your instance can create an account, and combined with an identity provider such as Google (with no `hosted-domain`), anyone with an account at that provider can register.
:::

## Email and password

Email and password accounts are on by default, for teams without an identity provider.

```yaml
email-password:
  enabled: true
  passkeys: true
```

Set `enabled: false` to allow only identity-provider sign-in. Passkeys are part of this method, so turning it off also turns off passkeys.

There is no "forgot password" flow today, either self-service or by an admin. Encourage password users to also register a passkey, which gives them a second way in.

### Authenticator apps (TOTP)

Any password user can add an authenticator app as a second factor from the user menu, **Security**, **Authenticator app**, **Set up authenticator app**. Setup asks for the current password, shows a QR code to scan, and then shows backup codes. Each backup code signs you in once if the authenticator is lost; generating new codes replaces the old ones.

Once it is on, signing in with the password asks for a code from the app. The authenticator only guards password sign-in; it is not asked for on passkey or identity-provider sign-ins.

### Passkeys

With `email-password.passkeys: true` (the default), users can register passkeys (a device's fingerprint, face, or screen lock, or a security key) under **Security**, **Passkeys**, and then use **Sign in with a passkey** on the sign-in page.

- Passkeys need `server.external-url` to be the `https://` origin people browse to, or `http://localhost`. Browsers do not allow passkeys on plain `http://` addresses other than localhost.
- Passkeys are bound to the host name in `server.external-url`. If you change it, people need to register their passkeys again.
- Only accounts that have a Checkpoint password (or already have a passkey) can add one. Someone who signs in only through an identity provider cannot, so that a person the provider disables cannot keep a way in. They see: "Passkeys are only for accounts with a Checkpoint password. Your identity provider manages how you sign in."
- A user with a passkey can go passwordless under **Security**, **Go passwordless**, **Remove password**. This also removes their authenticator app, which only protected the password. Checkpoint refuses if there is no passkey or identity provider left to sign in with.

## Requiring MFA for an organization

An org admin can require two-factor authentication for everyone in an organization: org settings, **Require two-factor authentication**. The admin must meet the requirement first; otherwise Checkpoint refuses with "Turn on two-factor authentication for your own account before requiring it for the organization."

Who meets the requirement:

| Account | Meets it when |
| --- | --- |
| Has a Checkpoint password | An authenticator app (TOTP) is turned on. A password counts even if the person also uses an identity provider. |
| No password, has a passkey | Always (the passkey is the strong credential). |
| No password, signs in only through an identity provider | Always. The identity provider is responsible for MFA, so enforce it there. |
| No password, passkey, or identity provider (a token-only account, such as a CI service account) | Always, since it cannot sign in to the web app. |

If `email-password.enabled` is `false`, stored passwords are not a way in, so they do not count.

Members who do not meet it keep their membership and grants, but are treated as outsiders: they lose access to the org's repositories (in the web app, the desktop app, the CLI, and with API tokens) until they set up a second factor. They see a banner linking to **Security**, and the errors they get start with `MFA required:`. The org's members page marks them **Blocked: no MFA**, and the settings card lists who would lose access before you turn it on. Members can still see who the org's admins are, so they know whom to ask.

## Enterprise identity providers

Each provider you enable gets a **Sign in with ...** button on the sign-in page. All of them are off by default. Register Checkpoint with the provider as a web application using this callback (redirect) URL:

```text
<server.external-url>/api/auth/callback/<id>
```

where `<id>` is the provider's key below. For example, with `server.external-url: https://checkpoint.example.com`, Okta's callback is `https://checkpoint.example.com/api/auth/callback/okta`.

Client secrets can be secret references (`secret|<name>`), so they can live in `config/.secrets` instead of `auth.yaml`.

| Provider | Key (`<id>`) | Settings besides `client.id` and `client.secret` |
| --- | --- | --- |
| Okta | `okta` | `issuer`, for example `https://your-org.okta.com/oauth2/default` |
| Auth0 | `auth0` | `issuer`: your Auth0 domain, for example `https://your-tenant.us.auth0.com` |
| Google Workspace | `google` | `hosted-domain` (see below) |
| Microsoft Entra ID | `microsoft-entra-id` | `tenant-id`: the directory (tenant) ID GUID |
| Keycloak | `keycloak` | `issuer`: the realm URL, for example `https://keycloak.example.com/realms/checkpoint` |
| Any other OpenID Connect provider | `oidc` | `name`, `discovery-url`, `scopes`, `pkce` |

Okta, Auth0, Entra ID, and Keycloak find their endpoints through the provider's OpenID Connect discovery document, derived from `issuer` or `tenant-id`.

### Examples

Okta, with the secret in `config/.secrets` as `okta_client_secret=...`:

```yaml
okta:
  enabled: true
  client:
    id: "0oa1example"
    secret: "secret|okta_client_secret"
  issuer: "https://your-org.okta.com/oauth2/default"
```

Microsoft Entra ID:

```yaml
microsoft-entra-id:
  enabled: true
  client:
    id: "00000000-0000-0000-0000-000000000000"
    secret: "secret|entra_client_secret"
  tenant-id: "11111111-1111-1111-1111-111111111111"
```

Google Workspace:

```yaml
google:
  enabled: true
  client:
    id: "1234-example.apps.googleusercontent.com"
    secret: "secret|google_client_secret"
  hosted-domain: "example.com"
```

`hosted-domain` is checked against the token Google returns, so it is a real restriction:

- `"example.com"` accepts only accounts in that Workspace domain.
- `"*"` accepts any Workspace domain.
- `""` (the default) also accepts personal Google accounts.

Generic OpenID Connect:

```yaml
oidc:
  enabled: true
  name: "Company SSO" # the button reads "Sign in with Company SSO"
  client:
    id: "checkpoint"
    secret: "secret|oidc_client_secret"
  discovery-url: "https://idp.example.com/.well-known/openid-configuration"
  scopes: ["openid", "email", "profile"]
  pkce: true
```

Its callback URL is `<server.external-url>/api/auth/callback/oidc`.

### How provider sign-in interacts with the rest

- New accounts still follow `invite-only`: invite people by the email address the provider will report for them.
- Identity-provider sign-ins skip Checkpoint's authenticator-app step. Enforce MFA in the provider.
- If you use only identity providers, you can set `email-password.enabled: false`. Keep at least one way in for the instance admin before you do.

## Dev login (keep it off)

```yaml
dev:
  allow-dev-login: false
```

Dev login exists for automated tests. When it is on, anyone who can reach the API can get a never-expiring API token for **any** email address, including the instance admin's, without a password, and can create accounts that skip the invitation check. Never enable it on an instance other people can reach. It is off by default; the app's `test` config environment turns it on, so do not run a real instance with `NODE_CONFIG_ENV=test`.

## Desktop app and CLI sign-in

The desktop app and the CLI sign in through the browser with a device code:

1. The client asks the server for a six-character code and opens `<server>/settings/devices?code=<CODE>` in your browser. The CLI also prints the URL and code (`chk login --endpoint https://checkpoint.example.com`).
2. Sign in to the web app if needed. The **Devices & Tokens** page opens with the code filled in. Give the device a name, choose an expiration, and click **Create Token**.
3. The client picks up the token on its own. The code works once, and only for 10 minutes after the token is created. The CLI waits up to 5 minutes for you to approve it.

The client stores the token in `~/.checkpoint/auth.json`. See [Desktop app](../clients/desktop-app.md) and [CLI](../clients/cli.md).

## API tokens for CI and build machines

For machines where nobody can click through a browser, create a token by hand:

1. In the web app, open the user menu, **Devices & Tokens**.
2. Enter a token name, leave **Device Code** empty, choose an expiration (none, 1 week, 1 month, or 1 year), and click **Create Token**.
3. Copy the token from the dialog. It is shown only once.

Then sign in on the machine without a browser:

```bash
chk login --endpoint https://checkpoint.example.com --token <token>
```

The daemon also accepts a token from its environment: `CHECKPOINT_API_TOKEN` (plus `CHECKPOINT_ENDPOINT` when there is no saved login for that server) takes precedence over `auth.json`.

A token acts as the user who created it, with all of that user's access. For CI, consider a dedicated account invited with only the access the build needs. Keep tokens out of logs and source control.

To revoke a token or a signed-in device, use the revoke button next to it on **Devices & Tokens**. Each user manages only their own tokens.

## Related

- [Organizations and access](./organizations-and-access.md): instance admins, org roles, invitations, and repository access.
- [Configuration](./configuration.md): config files, secrets, and email (SMTP) for invitation emails.
- [Troubleshooting](../troubleshooting.md): sign-in and startup errors.
