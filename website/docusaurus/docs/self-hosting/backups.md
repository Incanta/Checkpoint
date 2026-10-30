---
sidebar_position: 5
---

# Backups

A Checkpoint server keeps its state in three places. Back up all three, regularly, and test a restore before you need one.

| What          | Where                                                                                        | Holds                                                                                     |
| ------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Database      | The `postgres-data` volume or your own PostgreSQL server (default), or the `app-data` volume with SQLite | Users, organizations, repositories, branches, changelists, file history, and checkouts |
| Storage       | The `storage-data` volume in `local` mode, your bucket in `s3` mode, or one bucket per repository in `r2` mode | File content: blocks and version indexes (and file-tree snapshot blocks, unless `state-tree.block-store` is `"postgres"`) |
| Configuration | `config/` and `config/.secrets`, plus `docker-compose.yaml`                                  | Addresses, storage settings, and the secrets                                              |

The `bundles` volume does not need a backup. It only holds downloaded Checkpoint versions, and a missing one is downloaded again.

## Order: database first, then storage

**Back up the database first, then storage.** Content in storage is only ever added, never changed or removed (except when a repository is deleted). So a storage copy taken after the database copy contains everything that database refers to.

The other order can lose data: a changelist submitted between the two copies would be in the database but its content would be missing from storage, and pulling it after a restore would fail.

## Find your volume names

Docker Compose prefixes volume names with the project name, which is the name of the directory holding `docker-compose.yaml` unless you set one. List them with:

```bash
docker volume ls
```

The examples below use `checkpoint_` as the prefix. Replace it with yours (for the release bundle extracted as-is, it is `docker-compose_`).

## Back up the database

### PostgreSQL

`pg_dump` makes a consistent copy while Checkpoint keeps running:

```bash
docker compose exec -T postgres pg_dump -U checkpoint checkpoint > checkpoint-db.sql
```

For an external PostgreSQL server, run `pg_dump` against it with your usual tooling.

### SQLite

A plain copy of a live SQLite file can be torn, and the runtime image does not include the `sqlite3` tool. Stop the app for the copy:

```bash
docker compose stop app
docker run --rm -v checkpoint_app-data:/data -v "$PWD":/backup alpine tar czf /backup/app-data.tgz -C /data .
docker compose start app
```

## Back up storage

### local

Copy the `storage-data` volume. Do it after the database backup. The storage server can keep running, since content is only added.

```bash
docker run --rm -v checkpoint_storage-data:/data -v "$PWD":/backup alpine tar czf /backup/storage.tgz -C /data .
```

If you replaced the volume with a bind mount, back up that directory with any file backup tool.

### s3 and r2

Use the provider's own protection: turn on bucket versioning or replication, or sync the bucket to another bucket or location after each database backup. In `r2` mode every repository has its own bucket named `checkpoint-<repository id>`, so cover all of them, including buckets for repositories created after you set up the backup.

## Back up configuration

Copy the whole `docker-compose` directory, including `config/.secrets`. Keep it somewhere as safe as the secrets themselves.

Without the same secrets, a restored server still works, but:

- A different `betterauth_secret` signs everyone out. Stored integration secrets (such as issue tracker tokens) can no longer be decrypted unless `security.encryption-key` is set, and must be re-entered.
- `storage_signing_key` must match between the app and storage server. A different value from before also invalidates the dedup index unless `storage.index.signing-key` is set, which costs re-uploads.

## Restore

1. Stop the services: `docker compose down` (this keeps volumes).
2. Put back the configuration directory.
3. Restore storage: extract `storage.tgz` into the `storage-data` volume, or restore your bucket(s).
4. Restore the database:
   - **PostgreSQL:** if the `postgres-data` volume still holds the old database, remove it first (`docker volume rm checkpoint_postgres-data`). Start only the database, `docker compose up -d postgres`, then load the dump into an empty database: `docker compose exec -T postgres psql -U checkpoint checkpoint < checkpoint-db.sql`.
   - **SQLite:** extract `app-data.tgz` into the `app-data` volume.
5. Start everything: `docker compose up -d`.

Restore onto the same Checkpoint version the backup was taken from, or a newer one. The app applies newer migrations on boot, but an older version may not work with a database that has migrations it doesn't know about. If you have installed updates since the backup, keep the `bundles` volume as it is.

## After restoring an older backup

Workspaces on your team's machines may be ahead of the restored server: they may have synced changelists that are newer than the backup, and those changelists no longer exist on the server. The daemon does not expect this.

After a restore from anything but a very recent backup:

1. Ask everyone to copy any unsubmitted work out of their workspaces.
2. Have them create fresh workspaces against the restored server.
3. Re-apply their unsubmitted work and submit it again.

Changelists submitted after the backup are lost from the server. If someone still has those files locally, they can be submitted again as new changelists.
