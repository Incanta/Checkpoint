#!/usr/bin/env node
/**
 * Logs in as the CI test user through the app's dev login and writes the
 * resulting API token to ~/.checkpoint/auth.json, which is where the daemon,
 * the CLI, and the integration tests look for credentials.
 *
 * The Linux job does this inline with curl and jq. This is the same thing for
 * jobs that cannot count on either (Windows), and it resolves the home
 * directory the way Node does, which is the way the code under test does.
 *
 * Prints the daemon id it registered under. With GITHUB_OUTPUT set (in a
 * workflow step) it also writes DAEMON_ID and API_TOKEN there.
 *
 * Usage: node scripts/ci/dev-login.mjs [--app http://localhost:13000]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const appArg = process.argv.indexOf("--app");
const app = appArg >= 0 ? process.argv[appArg + 1] : "http://localhost:13000";
const daemonId = `ci-daemon-${Date.now()}`;

// Next.js compiles route handlers on first request in dev mode, so the first
// few attempts can fail while it warms up.
let apiToken;
let lastFailure = "";
for (let attempt = 1; attempt <= 30 && !apiToken; attempt++) {
  try {
    const response = await fetch(`${app}/api/trpc/auth.devLogin?batch=1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        0: {
          json: {
            email: "ci-test@checkpoint.dev",
            deviceCode: daemonId,
            tokenName: `ci-token-${daemonId}`,
          },
        },
      }),
    });
    const text = await response.text();
    if (response.ok) {
      apiToken = JSON.parse(text)[0]?.result?.data?.json?.apiToken;
      if (!apiToken) {
        lastFailure = `no token in response: ${text.slice(0, 300)}`;
      }
    } else {
      lastFailure = `HTTP ${response.status}: ${text.slice(0, 300)}`;
    }
  } catch (error) {
    lastFailure = String(error);
  }
  if (!apiToken) {
    console.log(`dev login attempt ${attempt} failed (${lastFailure}); retrying`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

if (!apiToken) {
  console.error(`dev-login: could not log in: ${lastFailure}`);
  process.exit(1);
}

const authDir = path.join(os.homedir(), ".checkpoint");
const authPath = path.join(authDir, "auth.json");
fs.mkdirSync(authDir, { recursive: true });

// Add to whatever is there rather than replace it.
let auth = { users: {} };
try {
  auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
  auth.users ??= {};
} catch {
  // No file yet.
}
auth.users[daemonId] = { endpoint: app, apiToken };
fs.writeFileSync(authPath, JSON.stringify(auth, null, 2));

console.log(`Wrote ${authPath} for daemon id ${daemonId}`);
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `DAEMON_ID=${daemonId}\nAPI_TOKEN=${apiToken}\n`,
  );
}
