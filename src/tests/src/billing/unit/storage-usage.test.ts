// Tests for storage-usage.ts — `calculateStorageCharge` over the SeaweedFS
// path (R2 is mocked out by the harness via vitest-setup). The function
// fetches repo sizes from a backend HTTP endpoint, so we stub `fetch`
// per-test.

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { calculateStorageCharge } from "~/server/billing/storage-usage";
import { createTestDb, type TestDb } from "../harness/db";
import {
  enableLicenseManager,
  setSimulatedDay,
  clearSimulatedDay,
} from "../harness/gates";
import { makeOrg } from "../harness/fixtures";
import { setConfig } from "../harness/config";

const GB = 1024 * 1024 * 1024;

function mockRepoSizes(sizes: number[]): void {
  // Each repo triggers one fetch to `${backendUrl}/repo-size`. Return them
  // in order; if a test creates N repos, give it N sizes.
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const size = sizes[i] ?? 0;
      i += 1;
      return new Response(JSON.stringify({ size }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

async function makeRepo(
  db: import("@prisma/client").PrismaClient,
  orgId: string,
): Promise<string> {
  const repo = await db.repo.create({
    data: { name: `r-${Math.random().toString(36).slice(2)}`, orgId },
  });
  return repo.id;
}

describe("storage-usage", () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  }, 120_000);

  afterAll(async () => {
    await testDb.teardown();
  });

  beforeEach(async () => {
    await testDb.reset();
    enableLicenseManager();
    setSimulatedDay(new Date("2026-06-15T12:00:00Z"));
    // Defaults: freeTierGb=0, bucketSizeGb=50, bucketPriceCents=250.
  });

  afterAll(() => {
    clearSimulatedDay();
  });

  it("returns zero charge when total usage is within the free tier", async () => {
    setConfig("stripe.storage.free-tier-gb", 25);
    const org = await makeOrg(testDb.client);
    await makeRepo(testDb.client, org.id);
    mockRepoSizes([10 * GB]); // 10 GB total, under 25 GB free tier

    const r = await calculateStorageCharge(org.id, testDb.client);

    expect(r.totalBytes).toBe(10 * GB);
    expect(r.buckets).toBe(0);
    expect(r.chargeCents).toBe(0);
  });

  it("ceils to the next bucket when usage exceeds free tier", async () => {
    // free=0, bucket=50 GB, price=250c. 60 GB usage → 2 buckets → 500c.
    const org = await makeOrg(testDb.client);
    await makeRepo(testDb.client, org.id);
    mockRepoSizes([60 * GB]);

    const r = await calculateStorageCharge(org.id, testDb.client);

    expect(r.buckets).toBe(2);
    expect(r.chargeCents).toBe(500);
  });

  it("sums sizes across multiple repos", async () => {
    const org = await makeOrg(testDb.client);
    await makeRepo(testDb.client, org.id);
    await makeRepo(testDb.client, org.id);
    await makeRepo(testDb.client, org.id);
    mockRepoSizes([20 * GB, 30 * GB, 25 * GB]); // 75 GB

    const r = await calculateStorageCharge(org.id, testDb.client);

    expect(r.totalBytes).toBe(75 * GB);
    // 75 GB > 50 GB bucket → 2 buckets → 500c.
    expect(r.buckets).toBe(2);
    expect(r.chargeCents).toBe(500);
  });

  it("uses recorded peak when it exceeds current usage", async () => {
    const org = await makeOrg(testDb.client, { billingCycleAnchor: 1 });
    await makeRepo(testDb.client, org.id);
    // Seed a peak of 200 GB for June 2026.
    await testDb.client.orgStoragePeak.create({
      data: {
        orgId: org.id,
        year: 2026,
        month: 6,
        peakStorageBytes: BigInt(200 * GB),
      },
    });
    mockRepoSizes([10 * GB]); // current is only 10 GB

    const r = await calculateStorageCharge(org.id, testDb.client);

    // Effective = max(current=10, peak=200) = 200 GB → ceil(200/50)=4 buckets.
    expect(r.buckets).toBe(4);
    expect(r.chargeCents).toBe(1000);
  });

  it("updates the peak when current usage exceeds the recorded peak", async () => {
    const org = await makeOrg(testDb.client, { billingCycleAnchor: 1 });
    await makeRepo(testDb.client, org.id);
    await testDb.client.orgStoragePeak.create({
      data: {
        orgId: org.id,
        year: 2026,
        month: 6,
        peakStorageBytes: BigInt(50 * GB),
      },
    });
    mockRepoSizes([120 * GB]);

    await calculateStorageCharge(org.id, testDb.client);

    const updated = await testDb.client.orgStoragePeak.findUniqueOrThrow({
      where: { orgId_year_month: { orgId: org.id, year: 2026, month: 6 } },
    });
    expect(Number(updated.peakStorageBytes)).toBe(120 * GB);
  });

  it("respects a custom bucket size and price", async () => {
    setConfig("stripe.storage.bucket-size-gb", 10);
    setConfig("stripe.storage.bucket-price-cents", 100);
    const org = await makeOrg(testDb.client);
    await makeRepo(testDb.client, org.id);
    mockRepoSizes([35 * GB]); // ceil(35/10) = 4 buckets

    const r = await calculateStorageCharge(org.id, testDb.client);

    expect(r.buckets).toBe(4);
    expect(r.chargeCents).toBe(400);
  });

  it("ignores soft-deleted repos", async () => {
    const org = await makeOrg(testDb.client);
    await makeRepo(testDb.client, org.id);
    const deleted = await makeRepo(testDb.client, org.id);
    await testDb.client.repo.update({
      where: { id: deleted },
      data: { deletedAt: new Date() },
    });
    // Only one alive repo → one fetch call.
    mockRepoSizes([5 * GB]);

    const r = await calculateStorageCharge(org.id, testDb.client);

    expect(r.totalBytes).toBe(5 * GB);
  });
});
