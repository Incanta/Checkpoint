import { Router, type Request, type Response } from "express";
import config from "@incanta/config";
import njwt from "njwt";
import multer from "multer";
import fs from "fs/promises";
import path from "path";
import { createReadStream } from "fs";

// ============================================================================
// Types matching the SeaweedFS filer JSON API
// ============================================================================

interface FilerChunk {
  file_id: string;
  size: number;
  mtime: number;
  e_tag: string;
}

interface FilerEntry {
  FullPath: string;
  Mode: number;
  chunks?: FilerChunk[];
}

interface FilerListResponse {
  Path: string;
  Entries: FilerEntry[] | null;
  Limit: number;
  LastFileName: string;
  ShouldDisplayLoadMore: boolean;
}

interface UserJWTClaims {
  iss: string;
  userId: string;
  orgId: string;
  repoId: string;
  mode: string;
  basePath: string;
}

const DIR_MODE_BIT = 0x80000000;
const PAGE_LIMIT = 100;

/**
 * Rename with retry — works around Windows EPERM / EACCES errors that occur
 * when the target file is momentarily locked (e.g. a recently-closed read
 * stream whose handle hasn't been fully released yet).
 */
async function renameWithRetry(
  source: string,
  target: string,
  maxRetries = 5,
  baseDelayMs = 50,
): Promise<void> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await fs.rename(source, target);
      return;
    } catch (err: any) {
      const isRetryable =
        process.platform === "win32" &&
        (err.code === "EPERM" || err.code === "EACCES") &&
        attempt < maxRetries;
      if (!isRetryable) throw err;
      await new Promise((r) => setTimeout(r, baseDelayMs * (attempt + 1)));
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

function getStoragePath(): string {
  return path.resolve(config.get<string>("seaweedfs.stub.storage-path"));
}

/**
 * Resolve and validate a request path to a safe absolute filesystem path.
 * Prevents directory traversal attacks.
 */
function resolveFilePath(requestPath: string): string | null {
  const root = getStoragePath();
  const resolved = path.resolve(root, `.${requestPath}`);

  // Ensure the resolved path stays within the storage root
  if (!resolved.startsWith(root)) {
    return null;
  }

  return resolved;
}

/**
 * Verify the JWT in the Authorization header.
 * Returns true if valid, false otherwise (and sends an error response).
 */
function verifyAuth(req: Request, requestPath: string, res: Response): boolean {
  const authHeader = req.headers["authorization"];
  if (!authHeader) {
    res.status(401).send("Unauthorized: Missing authorization header");
    return false;
  }

  const [type, token] = authHeader.split(" ");
  if (type !== "Bearer" || !token) {
    res.status(401).send("Unauthorized: Invalid authorization type");
    return false;
  }

  let claims: UserJWTClaims;
  try {
    const signingKey = config.get<string>("seaweedfs.jwt.signing-key");
    const verifiedToken = njwt.verify(token, signingKey);

    if (!verifiedToken) {
      res.status(401).send("Unauthorized: Invalid token");
      return false;
    }

    claims = verifiedToken.body.toJSON() as unknown as UserJWTClaims;

    // Verify the token is for this path and has appropriate permissions
    if (claims.mode !== "read" && claims.mode !== "write") {
      res.status(403).send("Forbidden: Invalid token mode");
      return false;
    }

    const expectedBase = `/${claims.orgId}/${claims.repoId}`;
    if (!requestPath.startsWith(expectedBase)) {
      res.status(403).send("Forbidden: Token not valid for this path");
      return false;
    }

    if (
      (req.method === "PUT" ||
        req.method === "POST" ||
        req.method === "DELETE") &&
      claims.mode !== "write"
    ) {
      res.status(403).send("Forbidden: Token does not have write permissions");
      return false;
    }

    return true;
  } catch {
    res.status(401).send("Unauthorized: Invalid token");
    return false;
  }
}

// ============================================================================
// Handlers
// ============================================================================

/**
 * HEAD — return file metadata (Content-Length).
 * Used by the C++ wrapper's GetSize and IsFile operations.
 */
async function handleHead(
  requestPath: string,
  _req: Request,
  res: Response,
): Promise<void> {
  const fullPath = resolveFilePath(requestPath);
  if (!fullPath) {
    res.status(400).send("Bad Request: Invalid path");
    return;
  }

  try {
    const stat = await fs.stat(fullPath);
    if (stat.isFile()) {
      res.set("Content-Length", stat.size.toString());
      res.status(200).end();
    } else {
      res.status(404).end();
    }
  } catch {
    res.status(404).end();
  }
}

/**
 * GET — download a file, or list a directory (when Accept: application/json).
 * File serving is used by the C++ wrapper's Read operation.
 * Directory listing is used by submit.ts calculateRepoSize.
 */
async function handleGet(
  requestPath: string,
  req: Request,
  res: Response,
): Promise<void> {
  const fullPath = resolveFilePath(requestPath);
  if (!fullPath) {
    res.status(400).send("Bad Request: Invalid path");
    return;
  }

  let stat;
  try {
    stat = await fs.stat(fullPath);
  } catch {
    // If it's a JSON listing request for a non-existent dir, return empty
    if (req.headers.accept?.includes("application/json")) {
      const listResponse: FilerListResponse = {
        Path: requestPath,
        Entries: null,
        Limit: PAGE_LIMIT,
        LastFileName: "",
        ShouldDisplayLoadMore: false,
      };
      res.status(200).json(listResponse);
      return;
    }
    res.status(404).send("Not found");
    return;
  }

  // Directory listing (SeaweedFS filer JSON API)
  if (stat.isDirectory() && req.headers.accept?.includes("application/json")) {
    try {
      const dirEntries = await fs.readdir(fullPath, { withFileTypes: true });
      const lastFileName = req.query["lastFileName"] as string | undefined;

      // Sort entries by name for consistent pagination
      dirEntries.sort((a, b) => a.name.localeCompare(b.name));

      // Filter by lastFileName for pagination
      let filtered = dirEntries;
      if (lastFileName) {
        const idx = dirEntries.findIndex((e) => e.name === lastFileName);
        if (idx >= 0) {
          filtered = dirEntries.slice(idx + 1);
        }
      }

      // Apply page limit
      const page = filtered.slice(0, PAGE_LIMIT);
      const hasMore = filtered.length > PAGE_LIMIT;

      // Build SeaweedFS-compatible entry list
      const entries: FilerEntry[] = [];
      for (const entry of page) {
        const entryFullPath = path.join(fullPath, entry.name);
        const entryRequestPath = requestPath.endsWith("/")
          ? `${requestPath}${entry.name}`
          : `${requestPath}/${entry.name}`;

        if (entry.isDirectory()) {
          entries.push({
            FullPath: entryRequestPath,
            Mode: DIR_MODE_BIT,
          });
        } else {
          try {
            const entryStat = await fs.stat(entryFullPath);
            entries.push({
              FullPath: entryRequestPath,
              Mode: 0,
              chunks: [
                {
                  file_id: entry.name,
                  size: entryStat.size,
                  mtime: Math.floor(entryStat.mtimeMs / 1000),
                  e_tag: "",
                },
              ],
            });
          } catch {
            // Skip entries we can't stat
          }
        }
      }

      const listResponse: FilerListResponse = {
        Path: requestPath,
        Entries: entries.length > 0 ? entries : null,
        Limit: PAGE_LIMIT,
        LastFileName: page.length > 0 ? page[page.length - 1].name : "",
        ShouldDisplayLoadMore: hasMore,
      };

      res.status(200).json(listResponse);
    } catch (err) {
      console.error("Stub filer: directory listing error:", err);
      res.status(500).send("Internal server error");
    }
    return;
  }

  // File download
  if (stat.isFile()) {
    res.set("Content-Length", stat.size.toString());
    const stream = createReadStream(fullPath);
    stream.on("error", (err) => {
      console.error("Stub filer: read stream error:", err);
      if (!res.headersSent) {
        res.status(500).send("Internal server error");
      }
    });
    stream.pipe(res);
    return;
  }

  res.status(404).send("Not found");
}

/**
 * POST — upload a file, rename/move a file, or create a directory.
 *
 * Behaviors:
 *   - `?mv.from=<source>`: Rename/move from source to target path.
 *   - `?op=append`: Append data to an existing file (used by C++ wrapper
 *     when writing stored blocks, which are written in two passes:
 *     first the block index header, then the chunk data).
 *   - No files in body: Create directory (mkdir).
 *   - Multipart file upload: Write file to disk.
 *
 * Used by the C++ wrapper's Write, RenameFile, and LockFile operations,
 * and by submit.ts writeRepoSize and system.ts mkdir.
 */
async function handlePost(
  requestPath: string,
  req: Request,
  res: Response,
): Promise<void> {
  const mvFrom = req.query["mv.from"] as string | undefined;

  // Rename / move operation
  if (mvFrom) {
    const sourcePath = resolveFilePath(mvFrom);
    const targetPath = resolveFilePath(requestPath);

    if (!sourcePath || !targetPath) {
      res.status(400).send("Bad Request: Invalid path");
      return;
    }

    try {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await renameWithRetry(sourcePath, targetPath);
      res.status(200).json({ success: true });
    } catch (err) {
      console.error("Stub filer: rename error:", err);
      res.status(500).send("Internal server error");
    }
    return;
  }

  const files = req.files as Express.Multer.File[] | undefined;

  // No files — treat as mkdir
  if (!files || files.length === 0) {
    const dirPath = resolveFilePath(requestPath);
    if (!dirPath) {
      res.status(400).send("Bad Request: Invalid path");
      return;
    }

    try {
      await fs.mkdir(dirPath, { recursive: true });
      res.status(200).json({ success: true });
    } catch (err) {
      console.error("Stub filer: mkdir error:", err);
      res.status(500).send("Internal server error");
    }
    return;
  }

  // File upload
  const file = files[0];
  const fullPath = resolveFilePath(requestPath);
  if (!fullPath) {
    res.status(400).send("Bad Request: Invalid path");
    return;
  }

  const op = req.query["op"] as string | undefined;

  try {
    await fs.mkdir(path.dirname(fullPath), { recursive: true });

    if (op === "append") {
      // Append mode: used by Longtail_WriteStoredBlock which writes
      // a block in two passes — first the block index, then the chunk data.
      // The C++ wrapper adds ?op=append for offset > 0 writes.
      await fs.appendFile(fullPath, file.buffer);
    } else {
      // Normal write: create/replace the file atomically.
      // Write to a temp file first, then rename for atomicity.
      // This prevents partial reads from concurrent downloaders.
      const tmpPath = `${fullPath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
      await fs.writeFile(tmpPath, file.buffer);
      await renameWithRetry(tmpPath, fullPath);
    }

    res.status(201).json({ size: file.size });
  } catch (err) {
    console.error("Stub filer: write error:", err);
    res.status(500).send("Internal server error");
  }
}

/**
 * Unlink with retry — same Windows file-locking workaround as renameWithRetry.
 */
async function unlinkWithRetry(
  target: string,
  maxRetries = 5,
  baseDelayMs = 50,
): Promise<void> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await fs.unlink(target);
      return;
    } catch (err: any) {
      const isRetryable =
        process.platform === "win32" &&
        (err.code === "EPERM" || err.code === "EACCES") &&
        attempt < maxRetries;
      if (!isRetryable) throw err;
      await new Promise((r) => setTimeout(r, baseDelayMs * (attempt + 1)));
    }
  }
}

/**
 * DELETE — remove a file.
 * Used by the C++ wrapper's RemoveFile and UnlockFile operations.
 */
async function handleDelete(
  requestPath: string,
  _req: Request,
  res: Response,
): Promise<void> {
  const fullPath = resolveFilePath(requestPath);
  if (!fullPath) {
    res.status(400).send("Bad Request: Invalid path");
    return;
  }

  try {
    const stat = await fs.stat(fullPath);

    if (stat.isDirectory()) {
      await fs.rm(fullPath, { recursive: true });
    } else {
      await unlinkWithRetry(fullPath);
    }

    res.status(202).json({ success: true });
  } catch {
    // 404 is acceptable — the C++ wrapper treats 404 as success for unlock
    res.status(404).send("Not found");
  }
}

// ============================================================================
// Router
// ============================================================================

/**
 * Creates a stub filer router that serves files from the local disk,
 * implementing the subset of the SeaweedFS filer HTTP API used by
 * the Longtail C++ wrapper and the Core Server routes.
 *
 * This router should be mounted at `/filer` on the main Express app.
 * All requests are authenticated via JWT using the `seaweedfs.jwt.signing-key`.
 */
export function routeStubFiler(): Router {
  const router = Router();
  const upload = multer({ storage: multer.memoryStorage() });

  // Ensure the storage directory exists on startup
  const storagePath = getStoragePath();
  fs.mkdir(storagePath, { recursive: true }).catch((err) => {
    console.error("Stub filer: failed to create storage directory:", err);
  });
  console.log(`Stub filer: serving files from ${storagePath}`);

  // Shared auth + dispatch helper
  async function dispatch(req: Request, res: Response): Promise<void> {
    // req.path is relative to the mount point (/filer)
    const requestPath = decodeURIComponent(req.path);

    if (!verifyAuth(req, requestPath, res)) return;

    switch (req.method) {
      case "HEAD":
        await handleHead(requestPath, req, res);
        break;
      case "GET":
        await handleGet(requestPath, req, res);
        break;
      case "POST":
        await handlePost(requestPath, req, res);
        break;
      case "DELETE":
        await handleDelete(requestPath, req, res);
        break;
      default:
        res.status(405).send("Method not allowed");
    }
  }

  // HEAD requests
  router.head("/*splat", async (req, res) => {
    await dispatch(req, res);
  });

  // GET requests
  router.get("/*splat", async (req, res) => {
    await dispatch(req, res);
  });

  // POST requests (with multer for multipart upload support)
  router.post("/*splat", upload.any(), async (req, res) => {
    await dispatch(req, res);
  });

  // DELETE requests
  router.delete("/*splat", async (req, res) => {
    await dispatch(req, res);
  });

  return router;
}
