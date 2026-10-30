---
sidebar_position: 7
---

# Issue trackers

Each repository chooses where its issues live: Checkpoint's built-in issues, an external tracker, or nowhere. With an external tracker, the repository's **Issues** tab lists that tracker's issues, and issue references in changelist messages and merge requests link straight to them.

## Supported platforms

| Platform | What you need | Reference format |
|---|---|---|
| **Checkpoint** (default) | Nothing | `#123` |
| **Jira** | Site URL, account email, project key, and an API token | `#PROJ-123` |
| **HacknPlan** | Project ID and an API key | `#123` |
| **Codecks** (experimental) | Account subdomain and an API token | `#1a7` or `#$1a7` |
| **Disabled** | Nothing | none |

:::caution
The Codecks integration has not been verified against the live Codecks service yet. Treat it as experimental, and let us know if listing or links don't work for you.
:::

## Configure a repository's tracker

You need to be an admin of the repository.

1. In the web app, open the repository and go to **Settings**.
2. In the **Issues** card, pick the **Issues platform**.
3. Fill in the fields for that platform:
   - **Jira**: the Jira base URL (for example `https://your-site.atlassian.net`), the account email the API token belongs to, the project key (for example `PROJ`), and the API token.
   - **HacknPlan**: the project ID and an API key.
   - **Codecks**: your account's subdomain (`your-team` for `your-team.codecks.io`) and an API token.
4. Click **Save issue settings**.
5. Click **Test connection** to check the credentials. On success it reports how many issues it found.

The token is encrypted before it is stored, and it is never sent back to the browser: the field just shows that one is saved. Leave it blank to keep the saved token. You must enter it again if you switch platforms or change the Jira URL.

:::note For self-hosters
Tokens are encrypted with the key in the server's `security.encryption-key` setting (32 bytes, base64; generate one with `openssl rand -base64 32`). If it isn't set, the key is derived from `auth.secret`, and rotating `auth.secret` makes saved tracker tokens unreadable, so admins have to re-enter them. See [Configuration](../self-hosting/configuration.md).
:::

## The Issues tab

- **Checkpoint**: the built-in issue tracker.
- **Jira, HacknPlan, or Codecks**: a read-only list of up to 100 issues from the configured project (for Jira and Codecks, the most recently updated). Selecting an issue opens it in the tracker. The list is cached for about a minute.
- **Disabled**: the Issues tab is hidden.

## Issue references

Only the configured platform's format is recognized, so `#123` is not linked in a repository that uses Jira. A reference needs the leading `#` and can't directly follow a letter, a digit, or another `#`.

| Platform | Write | Links to |
|---|---|---|
| Checkpoint | `Fixes #42` | The repository's issue 42 |
| Jira | `Fixes #PROJ-42` | `<Jira base URL>/browse/PROJ-42` |
| HacknPlan | `Fixes #42` | Task 42 on the project's HacknPlan board |
| Codecks | `Fixes #1a7` | `https://<subdomain>.codecks.io/card/1a7` |

References become links in the web app in:

- Changelist messages on the repository's **History** page.
- Merge request descriptions and comments.
- Issue descriptions and comments (Checkpoint issues).

The desktop app doesn't link issue references yet.
