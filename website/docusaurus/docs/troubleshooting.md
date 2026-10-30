---
sidebar_position: 7
---

# Troubleshooting

This page covers how to collect logs for a bug report, where each part of Checkpoint logs, and fixes for common problems.

## Reporting a bug

Report bugs on [GitHub Issues](https://github.com/Incanta/Checkpoint/issues) and attach a log bundle from the machine where the problem happened. If the problem involves the server, attach redacted server logs too (see [Server logs](#server-logs)).

### Collect a log bundle

- **Desktop app:** Settings, **Troubleshooting**, **Collect logs**. On macOS it is also in the menu bar under Help, **Collect Logs for a Bug Report**. The folder holding the zip opens when it is ready.
- **CLI:** `chk bug-report`. It prints the path of the zip. Run it inside a workspace to include that workspace when no daemon is running.

Bundles are written to `~/.checkpoint/bug-reports/`. The newest 10 are kept; older ones are deleted.

### What is in a bundle

| File | Contents |
| --- | --- |
| `README.txt` | What the bundle contains and exactly what is redacted and kept |
| `versions.json` | Checkpoint, daemon API, addon, Node.js, and OS versions |
| `daemon-config.json` | `~/.checkpoint/daemon.json`, redacted |
| `workspaces.json` | Per workspace: path, repo, branch, synced changelist, whether a pull was interrupted, counts of tracked, staged, and pending files, and recent pull and submit errors |
| `jobs.json` | Recent daemon jobs (pulls, submits, cleans) with their errors |
| `status/` | Updater and server-compatibility status |
| `logs/` | The daemon's log files, redacted |
| `client-logs/` | The desktop app's own log, redacted (only when collected from the desktop app) |

A bundle never contains `~/.checkpoint/auth.json`, any API or device token, or the contents of your files. Large logs are trimmed to keep the zip small, newest first.

**Redacted:** bearer tokens, Authorization and Cookie headers, JWTs, Checkpoint API tokens and other long hex strings, S3 and R2 keys, passwords in URLs, sensitive query parameters, values of keys named like password, secret, token, or apiKey, PEM private keys, email addresses (each replaced with a stable placeholder such as `[email-1]`), and your OS username in home-directory paths.

**Kept:** repo file paths, workspace-relative paths, workspace locations outside your home folder, server URLs, hostnames and IP addresses, changelist numbers, branch names, and repo and workspace ids, since bugs are debugged from them. Look the bundle over before sharing it, and edit out anything sensitive to you.

## Client logs

| Log | Location |
| --- | --- |
| Daemon | `~/.checkpoint/logs/daemon.log` |
| Daemon started by the CLI on its own (headless mode) | `~/.checkpoint/logs/ephemeral-daemon.log` |
| Daemon console output captured by the Windows tray (warnings, errors, and native crash output) | `daemon-process.log` in the same folder |
| Desktop app | `main.log` in the operating system's log folder for the app (included in bundles collected from the desktop app) |

`~` is your home folder (`C:\Users\<you>` on Windows).

The daemon always writes its log at `info` level. Each start archives the previous log, a log over `logging.logFile.maxFileSizeMB` (20 MB by default) is archived too, and `maxArchivedFiles` (10 by default) archives are kept. Both settings are in `~/.checkpoint/daemon.json`.

## Server logs

The app and the storage server log to their containers' standard output, so Docker holds their logs.

Watch the app while it starts:

```bash
docker compose logs -f app
```

A healthy app prints `[healthy] App is ready`. If it exits before that, the lines just above say why (see [Startup errors](#startup-errors)).

To attach server logs to a bug report, export the last day of both services and make a redacted copy with the Checkpoint CLI (on the server or any machine with Checkpoint installed):

```bash
docker compose logs --no-color --since 24h app server > logs.txt
chk redact logs.txt   # writes logs.redacted.txt beside it
```

Widen `--since` (for example `72h`) if the problem started earlier. `chk redact` applies the same rules as the bug-report bundle; use `--output <file>` to choose where the copy goes. Look the copy over before attaching it, and never attach `config/.secrets`.

## Common problems

### Startup errors

**`Refusing to sign sessions: ...`**

The app's auth secret is missing or weak. The full message says which:

- `no auth secret is configured`
- `the auth secret is a well-known placeholder`
- `the auth secret is too short (N characters, need at least 32)`
- `the auth secret has almost no variety in it`

Set `betterauth_secret` in `config/.secrets` (Docker Compose) or `CHECKPOINT_AUTH_SECRET` to the output of `openssl rand -hex 32`. See [Authentication](./self-hosting/authentication.md#the-auth-secret-required).

**`Refusing to use storage tokens: ...`**

The storage signing key is missing or weak, with the same kinds of reasons (`no storage signing key is configured`, `the storage signing key is too short (N characters, need at least 32)`, and so on). The app and the storage server both check it. Set `storage_signing_key` in `config/.secrets` or `CHECKPOINT_STORAGE_SIGNING_KEY` to a random value of at least 32 characters, the same on both services. See [Storage](./self-hosting/storage.md).

**Startup fails after editing `config/.secrets`**

Lines with an empty value are ignored, so a secret that a config file references must have a value. Check that each referenced key (for example `betterauth_secret`, `storage_signing_key`, and `database_url`) is filled in.

### Signing in

**"Registration is not yet available."**

Either the instance admin has not finished the one-time setup page that appears after the first sign-in, or the instance is invite-only (the default) and you opened the sign-in page without an invitation link. Ask your admin for an invitation. See [Inviting people](./self-hosting/organizations-and-access.md#inviting-people).

**"This invitation is no longer valid. It may have been revoked or already used."**

Ask the person who invited you for a new invitation.

**Sign-in through an identity provider does not create an account**

On an invite-only instance, the email address your identity provider reports must match a pending invitation. Ask your admin to invite that exact address.

**`MFA required: the organization "<name>" requires two-factor authentication. ...`**

The org requires two-factor authentication and your account does not meet it. Open the user menu, **Security**, and set up an authenticator app (or switch to a passkey and remove your password). See [Requiring MFA for an organization](./self-hosting/authentication.md#requiring-mfa-for-an-organization).

### Daemon and CLI

**How the CLI finds the daemon**

The CLI first looks for the resident daemon (the one the desktop app runs from the tray) on `http://127.0.0.1:13010`, or the port set as `daemonPort` in `~/.checkpoint/daemon.json`. If none answers, it starts a temporary daemon of its own (headless mode). If another program already uses port 13010, change `daemonPort` and restart the desktop app.

**`Failed to connect to daemon at <url>: <reason>`**

The CLI found a daemon but lost the connection to it, usually because the daemon stopped or crashed during the command. Check `~/.checkpoint/logs/daemon.log` (or `ephemeral-daemon.log` for a headless daemon), then run the command again.

**`Timed out starting the Checkpoint daemon. See <log> for details.`**

The CLI started its own daemon, but it did not become ready within 30 seconds. Read the file the message names (`ephemeral.log` in the workspace's `.checkpoint` folder, or in `~/.checkpoint` outside a workspace), and `~/.checkpoint/logs/ephemeral-daemon.log`.

**`Could not locate the bundled Checkpoint daemon runtime. ...`**

The CLI cannot find the daemon it ships with. Reinstall Checkpoint, or set `CHECKPOINT_DAEMON_BIN` to the folder containing `checkpoint-daemon` and `daemon-bundle.cjs`.

**`API version N is below the minimum required version M. Please upgrade to continue.`**

The client is too old for the server (or the desktop app or CLI is too old for the daemon). Update Checkpoint on that machine. See [Desktop app](./clients/desktop-app.md) and [CLI](./clients/cli.md).

**`Invalid API token or endpoint`** (from `chk login --token`)

The token is wrong, expired, or revoked, or `--endpoint` does not point at your server's web address. Create a new token under **Devices & Tokens**. See [API tokens for CI and build machines](./self-hosting/authentication.md#api-tokens-for-ci-and-build-machines).

**`CHECKPOINT_API_TOKEN is set but no endpoint is configured; set CHECKPOINT_ENDPOINT or log in first.`**

Set `CHECKPOINT_ENDPOINT` to your server's web address alongside the token.

### Storage

**`Unauthorized: Token verification failed`**

The storage server rejected a storage token from the app. Most often the app and the storage server have different storage signing keys: make sure `storage_signing_key` (or `CHECKPOINT_STORAGE_SIGNING_KEY`) is the same for both services, then restart them.

### Pulls

**`A pull to changelist N was interrupted. ...`** (in the daemon log)

A pull stopped partway (the daemon crashed, the machine restarted, or the app was quit mid-sync). When the daemon starts, or the next pull starts, it puts back every local change the pull had set aside. Pull again to finish syncing.

**`Pull stopped: an earlier pull to changelist N was interrupted, and some of your local changes it had set aside could not be put back yet. Close the programs using them and pull again`**

Some files the interrupted pull had set aside are locked by another program (an editor or game engine, for example). Close the programs using them and pull again. Until then, the local versions are kept in the workspace's `.checkpoint/pull-backups/` folder.

### Submits

**`The last pull (to changelist N) did not finish, so files it wrote look like local changes. Pull again before submitting. Your own local changes were put back.`**

Submits are refused after an interrupted pull until a pull completes. Pull, then submit.

**`Cannot submit: N files changed on "<branch>" since this workspace last synced. Nothing was submitted. Pull, resolve any conflicts, and submit again:`**

Someone submitted newer versions of files you changed. Each listed file shows your base and what the branch has now. Pull, resolve any conflicts, and submit again.

**`Cannot submit: the following files are claimed by others in the "<branch>" domain:`**

Someone else has claimed (checked out) those files. Ask them to submit or release their claim, or ask a repository admin to force-release it.

**`Could not submit to <branch>: other submits kept landing first. Nothing was changed; submit again.`**

Many submits arrived at once. Submit again.

**`<path> differs from <other> only in case or Unicode normalization, so on Windows and macOS they are one file. Rename one of them, or delete <other> in the same changelist`**

Windows and macOS treat names like `Hero.png` and `hero.png` as the same file, so a repo can't hold both. Rename one, or delete the old one in the same changelist (which is how a case-only rename works).

**`These paths cannot be stored in the repo:`**

Each listed path is followed by the reason. Some reasons apply to every repo (for example `a leading slash`, `a control character`, or `the workspace's .checkpoint directory`). Others are refused because some operating system can't store the name, so a teammate on that OS could not check it out:

- `a character Windows does not allow in names (< > : " | ? *)`
- `a name that ends in a dot or a space`
- `a name Windows reserves for a device` (such as `CON`, `NUL`, or `COM1`)
- `a name in the form of a Windows 8.3 short name`
- `a name longer than 255 bytes`

Rename the file or folder and submit again. Paths already in the repo before these rules are kept, so an older repo keeps working and can rename them.

### Still stuck?

Collect a [log bundle](#collect-a-log-bundle) and open an issue on [GitHub Issues](https://github.com/Incanta/Checkpoint/issues) with what you did, what you expected, and what happened.
