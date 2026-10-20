import config from "@incanta/config";
import type { PrismaClient } from "@prisma/client";

/**
 * How a repo's submitted content is chunked, hashed, and compressed. Every
 * client gets these with its storage token (storage.getToken), so a team's
 * daemons never disagree: changelists chunked or hashed differently cannot be
 * pulled in one pass.
 */
export interface LongtailParams {
  targetChunkSize: number;
  targetBlockSize: number;
  maxChunksPerBlock: number;
  minBlockUsagePercent: number;
  hashingAlgo: string;
  compressionAlgo: string;
}

const HASHING = new Set(["blake2", "blake3", "meow"]);
const COMPRESSION = new Set([
  "none",
  "lz4",
  "zstd",
  "zstd_min",
  "zstd_low",
  "zstd_high",
  "zstd_max",
  "brotli",
  "brotli_min",
  "brotli_max",
  "brotli_text",
  "brotli_text_min",
  "brotli_text_max",
]);

/** Why `params` cannot be used, or null when it can. */
export function longtailParamsProblem(params: unknown): string | null {
  if (typeof params !== "object" || params === null) return "not an object";
  const p = params as Record<string, unknown>;
  const positiveInt = (key: string, max: number): string | null => {
    const v = p[key];
    return typeof v === "number" && Number.isInteger(v) && v > 0 && v <= max
      ? null
      : `${key} must be a whole number from 1 to ${max}`;
  };
  return (
    positiveInt("targetChunkSize", 2 ** 30) ??
    positiveInt("targetBlockSize", 2 ** 31) ??
    positiveInt("maxChunksPerBlock", 2 ** 20) ??
    positiveInt("minBlockUsagePercent", 100) ??
    (typeof p.hashingAlgo === "string" && HASHING.has(p.hashingAlgo)
      ? null
      : `hashingAlgo must be one of ${[...HASHING].join(", ")}`) ??
    (typeof p.compressionAlgo === "string" && COMPRESSION.has(p.compressionAlgo)
      ? null
      : `compressionAlgo must be one of ${[...COMPRESSION].join(", ")}`)
  );
}

/** The instance's settings, from config/longtail.yaml. */
export function instanceLongtailParams(): LongtailParams {
  const params: LongtailParams = {
    targetChunkSize: config.get<number>("longtail.target-chunk-size"),
    targetBlockSize: config.get<number>("longtail.target-block-size"),
    maxChunksPerBlock: config.get<number>("longtail.max-chunks-per-block"),
    minBlockUsagePercent: config.get<number>(
      "longtail.min-block-usage-percent",
    ),
    hashingAlgo: config.get<string>("longtail.hashing-algo"),
    compressionAlgo: config.get<string>("longtail.compression-algo"),
  };
  const problem = longtailParamsProblem(params);
  if (problem) {
    throw new Error(`The longtail config is not usable: ${problem}`);
  }
  return params;
}

/**
 * The settings a repo's submits use: the ones it pinned the first time it was
 * used, or (pinning them now) the instance's current ones. Pinning means a
 * retuned instance changes new repos only.
 */
export async function repoLongtailParams(
  db: Pick<PrismaClient, "repo">,
  repo: { id: string; longtailParams: string | null },
): Promise<LongtailParams> {
  const pinned = parsePinned(repo.longtailParams);
  if (pinned) return pinned;

  const params = instanceLongtailParams();
  // Only if still unpinned: two first uses at once agree on one value.
  await db.repo.updateMany({
    where: { id: repo.id, longtailParams: null },
    data: { longtailParams: JSON.stringify(params) },
  });
  const after = await db.repo.findUnique({
    where: { id: repo.id },
    select: { longtailParams: true },
  });
  return parsePinned(after?.longtailParams ?? null) ?? params;
}

function parsePinned(value: string | null): LongtailParams | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (longtailParamsProblem(parsed) === null) {
      return parsed as LongtailParams;
    }
  } catch {
    // Unreadable JSON: refused below like any other unusable value.
  }
  // Never re-pinned: the repo's changelists were made with whatever it held.
  throw new Error(
    "This repo's pinned longtail settings (Repo.longtailParams) are not usable",
  );
}
