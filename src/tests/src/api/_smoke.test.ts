// Smoke test — confirms the harness wires up correctly:
//   - `@incanta/config` is mocked
//   - `server-only` import doesn't throw
//   - SQLite test DB spins up
//   - `makeAppCaller` returns a working tRPC caller bound to the test ctx
//
// If this fails, every other router test will too — fix this first.

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { createTestDb, type TestDb } from "../harness/db";
import { makeUser } from "../harness/fixtures";
import { makeAppCaller } from "../harness/caller";

describe("harness smoke", () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
    globalThis.__checkpointTestDb = testDb.client;
  }, 120_000);

  afterAll(async () => {
    await testDb.teardown();
    delete globalThis.__checkpointTestDb;
  });

  beforeEach(async () => {
    await testDb.reset();
  });

  it("can create a user via the fixture", async () => {
    const u = await makeUser(testDb.client, { email: "smoke@test.local" });
    expect(u.id).toBeTruthy();
    expect(u.email).toBe("smoke@test.local");
  });

  it("makeAppCaller returns a typed caller that calls public procedures", async () => {
    const caller = await makeAppCaller();
    const res = await caller.auth.checkUsername({ username: "nobody" });
    expect(res.available).toBe(true);
  });

  it("protected procedures throw UNAUTHORIZED without a session", async () => {
    const caller = await makeAppCaller();
    await expect(caller.org.myOrgs()).rejects.toThrow(/UNAUTHORIZED/);
  });

  it("protected procedures run with a synthesized session", async () => {
    const alice = await makeUser(testDb.client, { email: "alice@test.local" });
    const caller = await makeAppCaller({ asUser: alice });
    const orgs = await caller.org.myOrgs();
    expect(orgs).toEqual([]);
  });
});
