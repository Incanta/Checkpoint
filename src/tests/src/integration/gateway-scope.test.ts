/**
 * A storage token is scoped to one repo, and nothing a client can put in a URL
 * may reach outside it.
 *
 * The gateway used to check that the request path started with the token's
 * "/{org}/{repo}" and then hand the path to the backend, which resolved it.
 * "/orgA/repoA/../../orgB/repoB/store.lsi" passes the first and resolves to
 * orgB's store index in the second, so any user with access to one repo could
 * read, overwrite, and delete every other repo on the server.
 *
 * The same server also trusted any token signed with the storage key, and the
 * key defaulted to "secret".
 *
 * Needs a gateway storage mode (local or s3), which is what CI runs.
 */
import { createHmac, randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createContext,
  createWorkspace,
  enabled,
  headChangelistNumber,
  nativeSubmit,
  rawGatewayRequest,
  readCommitted,
  storageToken,
  versionIndexOf,
  write,
  type IntegrationContext,
  type LocalWorkspace,
} from "./harness.js";

const b64url = (value: Buffer | string) =>
  Buffer.from(value).toString("base64url");

/** An HS256 JWT signed with `key`, shaped like the app's storage tokens. */
function forgeToken(key: string, claims: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ typ: "JWT", alg: "HS256" }));
  const now = Math.floor(Date.now() / 1000);
  const body = b64url(JSON.stringify({ iat: now, exp: now + 3600, ...claims }));
  const signature = createHmac("sha256", key)
    .update(`${header}.${body}`)
    .digest();
  return `${header}.${body}.${b64url(signature)}`;
}

describe.skipIf(!enabled)("storage gateway: repo scope", () => {
  let attacker: IntegrationContext;
  let victim: IntegrationContext;
  let victimWs: LocalWorkspace;
  let victimContent: Buffer;
  let victimChangelist: number;
  let victimIndex: string;

  const victimBase = () => `/${victim.orgId}/${victim.repoId}`;
  const attackerBase = () => `/${attacker.orgId}/${attacker.repoId}`;

  beforeAll(async () => {
    attacker = await createContext("gateway-scope-a");
    victim = await createContext("gateway-scope-v");

    victimWs = await createWorkspace(victim, "victim");
    victimContent = randomBytes(8192);
    await write(victimWs, "secret.bin", victimContent);
    const outcome = await nativeSubmit(victim, victimWs, [
      { path: "secret.bin", delete: false },
    ]);
    expect(outcome.error).toBe(0);
    victimChangelist = outcome.changelistNumber!;
    victimIndex = await versionIndexOf(victim, victimChangelist);
  });

  afterAll(async () => {
    await victimWs?.cleanup();
  });

  /** Every spelling of "the victim's object" that starts inside the attacker's repo. */
  function escapes(object: string): string[] {
    const target = `${victim.orgId}/${victim.repoId}/${object}`;
    const a = attackerBase();
    return [
      `${a}/../../${target}`,
      `${a}/%2e%2e/%2e%2e/${target}`,
      `${a}/%2E%2E/%2E%2E/${target}`,
      `${a}/..%2f..%2f${target}`,
      `${a}/..%2F..%2F${target}`,
      `${a}/..%5c..%5c${target.replace(/\//g, "%5c")}`,
      `${a}/..\\..\\${target.replace(/\//g, "\\")}`,
      `${a}/%252e%252e/%252e%252e/${target}`,
      `${a}/chunks/../../../${target}`,
      `${a}/./../../${target}`,
      `${a}//../../${target}`,
      `${a}/../${attacker.repoId}/../../${target}`,
    ];
  }

  const victimMap = () => victimIndex.replace(/\.lvi$/, ".lsi");

  it("serves the victim's own objects to the victim (control)", async () => {
    const index = await rawGatewayRequest(
      victim,
      "GET",
      `${victimBase()}/versions/${victimIndex}`,
    );
    expect(index.status).toBe(200);
    expect(index.body.length).toBeGreaterThan(0);

    // The version's block map: written only by the server, like store.lsi
    // was before storage protocol 3.
    const map = await rawGatewayRequest(victim, "HEAD", `${victimBase()}/versions/${victimMap()}`);
    expect(map.status).toBe(200);
  });

  it("refuses another repo's objects addressed directly", async () => {
    for (const method of ["HEAD", "GET", "DELETE"] as const) {
      const res = await rawGatewayRequest(
        attacker,
        method,
        `${victimBase()}/store.lsi`,
      );
      expect(res.status).toBe(403);
    }
    const put = await rawGatewayRequest(attacker, "PUT", `${victimBase()}/store.lsi`, {
      body: randomBytes(16),
    });
    expect(put.status).toBe(403);
  });

  it("refuses to read another repo through any path that escapes the token's repo", async () => {
    for (const object of ["store.lsi", `versions/${victimIndex}`]) {
      for (const path of escapes(object)) {
        for (const method of ["HEAD", "GET"] as const) {
          const res = await rawGatewayRequest(attacker, method, path);
          expect([400, 403, 404], `${method} ${path}`).toContain(res.status);
          expect(res.body.length === 0 || res.status !== 200, path).toBe(true);
        }
      }
    }
  });

  it("refuses to write or delete in another repo through an escaping path", async () => {
    const before = await rawGatewayRequest(victim, "GET", `${victimBase()}/versions/${victimMap()}`);
    expect(before.status).toBe(200);

    for (const path of [...escapes("store.lsi"), ...escapes(`versions/${victimMap()}`)]) {
      const put = await rawGatewayRequest(attacker, "PUT", path, {
        body: randomBytes(64),
      });
      expect([400, 403, 404], `PUT ${path}`).toContain(put.status);

      const del = await rawGatewayRequest(attacker, "DELETE", path);
      expect([400, 403, 404], `DELETE ${path}`).toContain(del.status);
    }
    for (const path of escapes("planted.bin")) {
      await rawGatewayRequest(attacker, "PUT", path, { body: randomBytes(64) });
    }

    const after = await rawGatewayRequest(victim, "GET", `${victimBase()}/versions/${victimMap()}`);
    expect(after.status).toBe(200);
    expect(after.body.equals(before.body)).toBe(true);

    const planted = await rawGatewayRequest(victim, "HEAD", `${victimBase()}/planted.bin`);
    expect(planted.status).toBe(404);

    // And the victim's data is still what it committed.
    const read = await readCommitted(victim, victimChangelist, "secret.bin");
    expect(read.equals(victimContent)).toBe(true);
  });

  it("refuses paths that are not canonical even inside the token's own repo", async () => {
    const a = attackerBase();
    const paths = [
      `${a}/chunks/../store.lsi`,
      `${a}/./store.lsi`,
      `${a}//store.lsi`,
      `${a}/store.lsi/`,
      `${a}/store.lsi.`,
      `${a}/store.lsi%00.txt`,
      `${a}/store.lsi::$DATA`,
      `${a}/a%20b`,
      `${a}/%zz`,
    ];
    for (const path of paths) {
      const res = await rawGatewayRequest(attacker, "GET", path);
      expect(res.status, path).toBe(400);
    }
  });

  it("treats a version index as write-once however the directory is spelled", async () => {
    // Local storage on Windows and macOS is case-insensitive, so "Versions/"
    // names the same files as "versions/".
    for (const dir of ["Versions", "VERSIONS", "vErSiOnS"]) {
      const put = await rawGatewayRequest(
        victim,
        "PUT",
        `${victimBase()}/${dir}/${victimIndex}`,
        { body: randomBytes(128) },
      );
      expect(put.status, dir).toBe(400);

      const del = await rawGatewayRequest(
        victim,
        "DELETE",
        `${victimBase()}/${dir}/${victimIndex}`,
      );
      expect(del.status, dir).toBe(403);
    }

    const read = await readCommitted(victim, victimChangelist, "secret.bin");
    expect(read.equals(victimContent)).toBe(true);
  });

  it("does not let a read token write or delete", async () => {
    const key = `${attackerBase()}/readonly-probe.bin`;

    const put = await rawGatewayRequest(attacker, "PUT", key, {
      body: randomBytes(16),
      write: false,
    });
    expect(put.status).toBe(403);

    const del = await rawGatewayRequest(attacker, "DELETE", key, { write: false });
    expect(del.status).toBe(403);

    const head = await rawGatewayRequest(attacker, "HEAD", key);
    expect(head.status).toBe(404);
  });

  describe("token forgery", () => {
    const forgedClaims = () => ({
      iss: "checkpoint-vcs",
      sub: "forged",
      userId: "forged",
      orgId: victim.orgId,
      repoId: victim.repoId,
      mode: "write",
      basePath: victimBase(),
    });

    it.each(["secret", "", "changeme", "test-jwt-secret"])(
      "rejects a token signed with the placeholder key %j",
      async (key) => {
        const res = await rawGatewayRequest(
          victim,
          "GET",
          `${victimBase()}/store.lsi`,
          { bearer: forgeToken(key || "\0", forgedClaims()) },
        );
        expect(res.status).toBe(401);
      },
    );

    it("rejects an unsigned token and a tampered one", async () => {
      const header = b64url(JSON.stringify({ typ: "JWT", alg: "none" }));
      const body = b64url(
        JSON.stringify({ ...forgedClaims(), exp: Math.floor(Date.now() / 1000) + 3600 }),
      );
      const unsigned = await rawGatewayRequest(victim, "GET", `${victimBase()}/store.lsi`, {
        bearer: `${header}.${body}.`,
      });
      expect(unsigned.status).toBe(401);

      // The attacker's real token with the scope swapped for the victim's.
      const real = (await storageToken(attacker, true)).token.split(".");
      const tampered = await rawGatewayRequest(victim, "GET", `${victimBase()}/store.lsi`, {
        bearer: `${real[0]}.${body}.${real[2]}`,
      });
      expect(tampered.status).toBe(401);
    });
  });

  describe("submit endpoint", () => {
    async function postSubmit(bearer: string, repo: IntegrationContext) {
      const { serverUrl } = await storageToken(repo, true);
      const form = new FormData();
      form.set(
        "payload",
        JSON.stringify({
          apiToken: repo.apiToken,
          branchName: "main",
          message: "should never land",
          versionIndex: "",
          modifications: [{ delete: true, path: "secret.bin" }],
          keepCheckedOut: false,
          workspaceId: victimWs.workspaceId,
        }),
      );
      return fetch(`${serverUrl}/submit`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}` },
        body: form,
      });
    }

    it("refuses a read token", async () => {
      const before = await headChangelistNumber(victim);
      const { token } = await storageToken(victim, false);

      const res = await postSubmit(token, victim);
      expect(res.status).toBe(403);
      expect(await headChangelistNumber(victim)).toBe(before);
    });

    it("refuses a token signed with the old default key", async () => {
      const before = await headChangelistNumber(victim);
      const forged = forgeToken("secret", {
        iss: "checkpoint-vcs",
        sub: "forged",
        userId: "forged",
        orgId: victim.orgId,
        repoId: victim.repoId,
        mode: "write",
        basePath: victimBase(),
      });

      const res = await postSubmit(forged, victim);
      expect(res.status).toBe(401);
      expect(await headChangelistNumber(victim)).toBe(before);
    });

    it("refuses a request with no token", async () => {
      const { serverUrl } = await storageToken(victim, true);
      const form = new FormData();
      form.set("payload", JSON.stringify({}));
      const res = await fetch(`${serverUrl}/submit`, { method: "POST", body: form });
      expect([400, 401, 500]).toContain(res.status);
      expect(res.status).not.toBe(200);
    });
  });
});
