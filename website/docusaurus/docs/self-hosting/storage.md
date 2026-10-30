---
sidebar_position: 2
---

# Storage

Checkpoint keeps file content (chunked, deduplicated, compressed blocks and the version indexes that describe each changelist) separate from its database. This page covers where that content can live and how to configure it.

## Choosing a mode

| Mode    | Where content lives                                   | How clients reach it                                        | Good for                                         |
| ------- | ----------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------ |
| `local` | The storage server's own disk (default)               | Through the storage server                                  | Trying Checkpoint out and small teams            |
| `s3`    | One bucket on any S3-compatible store                 | Through the storage server, which proxies to the bucket     | Larger self-hosted setups, existing object storage |
| `r2`    | Cloudflare R2, one bucket per repository              | Directly to R2, with short-lived scoped credentials         | Cloud storage with free egress                   |

S3-compatible stores include MinIO, SeaweedFS's S3 gateway, AWS S3, and DigitalOcean Spaces.

:::warning Pick before you create repositories
Checkpoint has no tool to move existing content between modes, and in `r2` mode each repository records its bucket when it is created. Choose a mode before your team creates repositories.
:::

## Settings every mode needs

Two files configure storage, and some values must agree between them:

- `config/app/storage.yaml` (the app)
- `config/server/storage.yaml` (the storage server)

| Key               | App | Server | Notes                                                                                       |
| ----------------- | --- | ------ | ------------------------------------------------------------------------------------------- |
| `mode`            | yes | yes    | `local`, `s3`, or `r2`. Must be the same in both files.                                     |
| `jwt.signing-key` | yes | yes    | Must be the same value in both. The Compose bundle sets both to `secret\|storage_signing_key`. |

The app signs a storage token for each client request and the storage server verifies it with the shared key. Tokens last `token-expiration-seconds` (3600 by default, set in the app's `storage.yaml`). The `CHECKPOINT_STORAGE_SIGNING_KEY` environment variable overrides `jwt.signing-key` if set; set it on both services if you use it.

The app's `backend-url` settings (the address clients use for the storage server) are covered in [Deploy with Docker Compose](./deploy-docker-compose.md#3-set-the-host-address).

## local

The default. The storage server writes content under `local.path` in its `storage.yaml`. The Compose bundle sets this to `/app/data`, which is the `storage-data` volume.

```yaml
# config/server/storage.yaml
mode: "local"
local:
  path: "/app/data"
```

```yaml
# config/app/storage.yaml
mode: "local"
```

To put content on a specific disk, replace the `storage-data` volume on the `server` service with a bind mount, for example `- /mnt/checkpoint-storage:/app/data`. The directory must be writable by the container user (uid 1001).

## s3

The storage server keeps all content in one bucket, under a prefix per organization and repository. Clients never see the bucket or its credentials: they talk to the storage server, which proxies to S3.

1. Create the bucket. Checkpoint does not create it for you.
2. Create credentials that can read, write, list, and delete objects in that bucket.
3. Configure the storage server:

   ```yaml
   # config/server/storage.yaml
   mode: "s3"
   s3:
     endpoint: "http://minio:9000"   # or https://s3.<region>.amazonaws.com
     region: "us-east-1"
     bucket: "checkpoint"
     force-path-style: true          # MinIO and SeaweedFS usually need this
     access-key-id: "secret|s3_access_key_id"
     secret-access-key: "secret|s3_secret_access_key"
   ```

4. Set `mode: "s3"` in `config/app/storage.yaml`.
5. Add the credentials to `config/.secrets`:

   ```ini
   s3_access_key_id=...
   s3_secret_access_key=...
   ```

| Key                   | Meaning                                                                                  |
| --------------------- | ---------------------------------------------------------------------------------------- |
| `s3.endpoint`         | The S3 API endpoint.                                                                     |
| `s3.region`           | The bucket's region. MinIO and SeaweedFS accept any value.                               |
| `s3.bucket`           | The one bucket used for every repository.                                                |
| `s3.force-path-style` | Use `endpoint/bucket/key` URLs instead of `bucket.endpoint/key`. Default `true`.         |
| `s3.access-key-id`, `s3.secret-access-key` | Server-side credentials with full access to the bucket.         |

Run the S3 store yourself, outside this Compose file (for example a MinIO container on the same Docker network). The storage server must be able to reach `s3.endpoint`. Clients do not need to.

Checkpoint uses conditional writes (`If-None-Match`) for its internal locks where the store supports them (AWS S3 and current MinIO do), and double-checks the result on stores that ignore the condition.

## r2

In `r2` mode, Checkpoint creates a separate R2 bucket for each repository (named `checkpoint-<repository id>`) when the repository is created. Clients upload and download content directly from R2 using temporary credentials scoped to one bucket, which the app issues per request. The storage server still handles submits and some server-side reads and writes.

You need three things from your Cloudflare account:

- Your **account ID**.
- An **R2 access key ID and secret access key** with read and write access to the account's buckets.
- A **Cloudflare API token** that Checkpoint uses to create and delete buckets, issue the temporary client credentials, and read bucket usage.

Set `mode: "r2"` and the `r2` block in **both** storage files:

```yaml
# config/app/storage.yaml and config/server/storage.yaml
mode: "r2"
r2:
  account-id: "0123456789abcdef0123456789abcdef"   # a literal, not a secret
  access-key-id: "secret|r2_access_key_id"
  secret-access-key: "secret|r2_secret_access_key"
  api-token: "secret|r2_api_token"
```

```ini
# config/.secrets
r2_access_key_id=...
r2_secret_access_key=...
r2_api_token=...
```

Optionally, set `r2.location-override` in the app's `storage.yaml` to an R2 location hint for new buckets.

Clients need outbound HTTPS to `<account-id>.r2.cloudflarestorage.com`, and the Checkpoint host needs `api.cloudflare.com`. Clients still need the storage server's port (13001) for submits.

## The dedup index

The storage server keeps a deduplication index per repository (under `index/` in that repository's storage) so content that is already stored is not uploaded again. Two settings in the server's `storage.yaml` control it:

```yaml
index:
  signing-key: ""
  cache-bytes: 1073741824
```

| Key                 | Default        | Meaning                                                                                                                                                       |
| ------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.signing-key` | empty          | Key for the MACs on index object names. Empty means the storage signing key is used. `CHECKPOINT_STORAGE_INDEX_KEY` overrides it. A `secret\|name` reference works. |
| `index.cache-bytes` | 1 GiB          | Upper bound on memory used for in-memory repository indexes. Least recently used repositories are dropped past it.                                            |

Set `index.signing-key` to its own random value (`openssl rand -hex 32`) if you might ever rotate the storage signing key. Otherwise, changing the signing key invalidates every existing index segment, which costs re-uploads of content that was already stored.

## Content format (longtail.yaml)

How content is chunked, hashed, and compressed is one setting for the whole instance, sent to every client with its storage token, so teammates never need matching client configs. The defaults suit most teams:

| Key                       | Default             |
| ------------------------- | ------------------- |
| `target-chunk-size`       | `32768` (32 KiB)    |
| `target-block-size`       | `8388608` (8 MiB)   |
| `max-chunks-per-block`    | `1024`              |
| `min-block-usage-percent` | `80`                |
| `hashing-algo`            | `blake3` (`blake2`, `blake3`, or `meow`) |
| `compression-algo`        | `zstd` (also `none`, `lz4`, `zstd_min`, `zstd_low`, `zstd_high`, `zstd_max`, `brotli`, `brotli_min`, `brotli_max`, `brotli_text`, `brotli_text_min`, `brotli_text_max`) |

To change them, create `config/app/longtail.yaml` with only the keys you want to override.

:::info Fixed per repository
Each repository keeps the settings it was first used with. Changing `longtail.yaml` affects new repositories only, because changelists chunked or hashed differently cannot be pulled together.
:::

## State-tree blocks

The app also stores a content-addressed snapshot of each changelist's file tree. `state-tree.block-store` in the app config decides where:

- `"storage"` (default): in the configured storage backend, alongside file content.
- `"postgres"`: in the database's `TreeBlock` table.

Leave it at `"storage"` unless you have a reason to change it, and remember that it determines whether these blocks are covered by your database backup or your storage backup.

## How much disk to plan for

Disk use depends on your content. Checkpoint stores only chunks it has not seen before and compresses them, so repeated or lightly changed files cost less than their full size, but there is no fixed ratio. Content is only ever added (until a repository is deleted), so storage grows with history. Start with generous headroom and watch the `storage-data` volume, or your bucket's usage, as your team works.
