// BlockStore backed by the configured storage backend (R2 / SeaweedFS / stub),
// reached through the core storage server over HTTP (the same backend-url +
// system-JWT channel used for mkdir/rmdir). Blocks live alongside longtail
// content under /{orgId}/{repoId}/tree/{hash}; the core server routes the actual
// read/write to R2, the filer, or the local stub by storage.mode.

import config from "@incanta/config";
import type { PrismaClient } from "@prisma/client";
import { hashBytes, toHex } from "./hash";
import { createSystemToken } from "../storage-service";
import type { BlockStore, Hash } from "./tree";

type Db = Pick<PrismaClient, "repo">;

export class StorageBlockStore implements BlockStore {
  private info?: { orgId: string; bucket: string | null };

  constructor(
    private readonly db: Db,
    private readonly repoId: string,
  ) {}

  private async repoInfo(): Promise<{ orgId: string; bucket: string | null }> {
    if (!this.info) {
      const repo = await this.db.repo.findUniqueOrThrow({
        where: { id: this.repoId },
        select: { orgId: true, r2BucketName: true },
      });
      this.info = { orgId: repo.orgId, bucket: repo.r2BucketName };
    }
    return this.info;
  }

  private path(orgId: string, hash: string): string {
    return `/${orgId}/${this.repoId}/tree/${hash}`;
  }

  private backendUrl(): string {
    return config.get<string>("storage.backend-url.internal");
  }

  async put(bytes: Uint8Array): Promise<Hash> {
    const hash = toHex(hashBytes(bytes));
    const { orgId, bucket } = await this.repoInfo();
    const path = this.path(orgId, hash);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${createSystemToken("blob-put", path)}`,
      "x-checkpoint-path": path,
      "Content-Type": "application/octet-stream",
    };
    if (bucket) headers["x-checkpoint-bucket"] = bucket;

    const res = await fetch(`${this.backendUrl()}/system/blob`, {
      method: "PUT",
      headers,
      body: Buffer.from(bytes),
    });
    if (!res.ok) {
      throw new Error(`block put failed (${res.status}): ${await res.text()}`);
    }
    return hash;
  }

  async get(hash: Hash): Promise<Uint8Array> {
    const { orgId, bucket } = await this.repoInfo();
    const path = this.path(orgId, hash);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${createSystemToken("blob-get", path)}`,
      "x-checkpoint-path": path,
    };
    if (bucket) headers["x-checkpoint-bucket"] = bucket;

    const res = await fetch(
      `${this.backendUrl()}/system/blob?path=${encodeURIComponent(path)}`,
      { method: "GET", headers },
    );
    if (!res.ok) {
      throw new Error(
        `block get failed (${res.status}) for ${this.repoId}/${hash}`,
      );
    }
    return new Uint8Array(await res.arrayBuffer());
  }
}
