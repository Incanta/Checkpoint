import config from "@incanta/config";
import { promises as fs, createReadStream, createWriteStream } from "fs";
import path from "path";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getR2Client } from "../utils/r2.js";

// Unified storage backend used by every server-side data path (the client
// gateway, the system tree-block channel, repo-size, and store.lsi merge
// inputs). One streaming interface, three implementations selected by
// storage.mode. See STORAGE.md for the architecture.
//
// Keys are repo-scoped paths like "/{org}/{repo}/...". The leading slash is
// optional; implementations normalize it.

export type StorageMode = "local" | "s3" | "r2";

export interface StorageBackend {
  /** Object size in bytes, or null if it does not exist. */
  head(key: string): Promise<number | null>;
  /** A readable stream of the object, or null if it does not exist. */
  get(key: string): Promise<Readable | null>;
  /** The whole object as a Buffer, or null if it does not exist. */
  getBuffer(key: string): Promise<Buffer | null>;
  /** Write an object atomically (overwrite). contentLength must be accurate. */
  put(key: string, body: Readable | Buffer, contentLength: number): Promise<void>;
  /** Remove an object. Missing is not an error. */
  delete(key: string): Promise<void>;
  /** Total bytes stored under a "/{org}/{repo}" prefix. */
  sizeUnder(prefix: string): Promise<number>;
  /** Create a prefix (a dir on local disk; a no-op for object stores). */
  ensurePrefix(prefix: string): Promise<void>;
  /** Recursively remove everything under a prefix (repo deletion). */
  deletePrefix(prefix: string): Promise<void>;
}

export function storageMode(): StorageMode {
  return config.get<StorageMode>("storage.mode");
}

function normalizeKey(key: string): string {
  return key.replace(/^\/+/, "");
}

// ---------------------------------------------------------------------------
// Local disk backend (mode: local). Replaces the SeaweedFS-filer stub.
// ---------------------------------------------------------------------------

class LocalBackend implements StorageBackend {
  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    const resolved = path.resolve(this.root, normalizeKey(key));
    const root = path.resolve(this.root);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error(`path traversal rejected: ${key}`);
    }
    return resolved;
  }

  async head(key: string): Promise<number | null> {
    try {
      const stat = await fs.stat(this.resolve(key));
      return stat.isFile() ? stat.size : null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async get(key: string): Promise<Readable | null> {
    const full = this.resolve(key);
    if ((await this.head(key)) === null) return null;
    return createReadStream(full);
  }

  async getBuffer(key: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.resolve(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async put(key: string, body: Readable | Buffer): Promise<void> {
    const full = this.resolve(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    // Write to a temp file then rename so readers never see a partial object.
    const tmp = `${full}.tmp-${process.pid}-${Date.now()}`;
    if (Buffer.isBuffer(body)) {
      await fs.writeFile(tmp, body);
    } else {
      await pipeline(body, createWriteStream(tmp));
    }
    await fs.rename(tmp, full);
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.resolve(key), { force: true });
  }

  async sizeUnder(prefix: string): Promise<number> {
    const dir = this.resolve(prefix);
    let total = 0;
    const walk = async (d: string): Promise<void> => {
      let entries: import("fs").Dirent[];
      try {
        entries = await fs.readdir(d, { withFileTypes: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
        throw err;
      }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else if (e.isFile()) total += (await fs.stat(p)).size;
      }
    };
    await walk(dir);
    return total;
  }

  async ensurePrefix(prefix: string): Promise<void> {
    await fs.mkdir(this.resolve(prefix), { recursive: true });
  }

  async deletePrefix(prefix: string): Promise<void> {
    await fs.rm(this.resolve(prefix), { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// S3 backend (mode: s3, shared bucket; also used server-side for mode: r2
// against a per-repo bucket).
// ---------------------------------------------------------------------------

class S3Backend implements StorageBackend {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async head(key: string): Promise<number | null> {
    try {
      const out = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: normalizeKey(key) }),
      );
      return out.ContentLength ?? 0;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async get(key: string): Promise<Readable | null> {
    try {
      const out = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: normalizeKey(key) }),
      );
      return out.Body as Readable;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async getBuffer(key: string): Promise<Buffer | null> {
    try {
      const out = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: normalizeKey(key) }),
      );
      const bytes = await out.Body!.transformToByteArray();
      return Buffer.from(bytes);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async put(
    key: string,
    body: Readable | Buffer,
    contentLength: number,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: normalizeKey(key),
        Body: body,
        ContentLength: contentLength,
      }),
    );
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: normalizeKey(key) }),
    );
  }

  async sizeUnder(prefix: string): Promise<number> {
    let total = 0;
    await this.forEachUnder(prefix, (obj) => {
      total += obj.Size ?? 0;
    });
    return total;
  }

  async ensurePrefix(): Promise<void> {
    // Object stores have no directories; keys are created lazily on put.
  }

  async deletePrefix(prefix: string): Promise<void> {
    const keys: string[] = [];
    await this.forEachUnder(prefix, (obj) => {
      if (obj.Key) keys.push(obj.Key);
    });
    // Delete in batches of 1000 (S3 DeleteObjects limit).
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      await Promise.all(
        batch.map((Key) =>
          this.client.send(
            new DeleteObjectCommand({ Bucket: this.bucket, Key }),
          ),
        ),
      );
    }
  }

  private async forEachUnder(
    prefix: string,
    fn: (obj: { Key?: string; Size?: number }) => void,
  ): Promise<void> {
    let token: string | undefined;
    do {
      const out = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: normalizeKey(prefix),
          ContinuationToken: token,
        }),
      );
      for (const obj of out.Contents ?? []) fn(obj);
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);
  }
}

function isNotFound(err: unknown): boolean {
  const name = (err as { name?: string }).name;
  const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata
    ?.httpStatusCode;
  return name === "NoSuchKey" || name === "NotFound" || status === 404;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

let cachedS3: S3Client | null = null;

async function getS3Client(): Promise<S3Client> {
  if (cachedS3) return cachedS3;
  cachedS3 = new S3Client({
    endpoint: config.get<string>("storage.s3.endpoint"),
    region: config.get<string>("storage.s3.region"),
    forcePathStyle: config.get<boolean>("storage.s3.force-path-style"),
    credentials: {
      accessKeyId: await config.getWithSecrets<string>(
        "storage.s3.access-key-id",
      ),
      secretAccessKey: await config.getWithSecrets<string>(
        "storage.s3.secret-access-key",
      ),
    },
  });
  return cachedS3;
}

/**
 * The backend for the current storage.mode. For mode "r2" a per-repo bucket
 * must be supplied (the client accesses R2 directly, but the server still
 * reads/writes tree blocks, repo-size, and the store index server-side).
 */
export async function getStorageBackend(opts?: {
  bucket?: string;
}): Promise<StorageBackend> {
  switch (storageMode()) {
    case "local":
      return new LocalBackend(config.get<string>("storage.local.path"));
    case "s3":
      return new S3Backend(
        await getS3Client(),
        config.get<string>("storage.s3.bucket"),
      );
    case "r2": {
      if (!opts?.bucket) {
        throw new Error("r2 backend requires a per-repo bucket");
      }
      return new S3Backend(await getR2Client(), opts.bucket);
    }
    default:
      throw new Error(`unknown storage.mode: ${storageMode()}`);
  }
}

/** True when the client reaches storage through the core-server gateway. */
export function usesGateway(): boolean {
  const mode = storageMode();
  return mode === "local" || mode === "s3";
}
