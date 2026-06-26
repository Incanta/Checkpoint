// BlockStore backed by the Postgres `TreeBlock` table (initial backing).
//
// Blocks are content-addressed and immutable, so put is an idempotent
// insert-if-absent. The same BlockStore interface can later be repointed at R2
// or SeaweedFS (blocks in object storage, this pointer table dropped) without
// touching the tree algorithm or the wire contract.

import type { PrismaClient } from "@prisma/client";
import { hashBytes, toHex } from "./hash";
import type { BlockStore, Hash } from "./tree";

// A Prisma client or an interactive-transaction client.
type Db = Pick<PrismaClient, "treeBlock">;

export class PrismaBlockStore implements BlockStore {
  constructor(
    private readonly db: Db,
    private readonly repoId: string,
  ) {}

  async put(bytes: Uint8Array): Promise<Hash> {
    const hash = toHex(hashBytes(bytes));
    // Idempotent: a block with this content hash is identical, so do nothing on
    // conflict.
    await this.db.treeBlock.upsert({
      where: { repoId_hash: { repoId: this.repoId, hash } },
      create: { repoId: this.repoId, hash, data: Buffer.from(bytes) },
      update: {},
    });
    return hash;
  }

  async get(hash: Hash): Promise<Uint8Array> {
    const row = await this.db.treeBlock.findUnique({
      where: { repoId_hash: { repoId: this.repoId, hash } },
      select: { data: true },
    });
    if (!row) throw new Error(`missing tree block ${this.repoId}/${hash}`);
    return new Uint8Array(row.data);
  }
}
