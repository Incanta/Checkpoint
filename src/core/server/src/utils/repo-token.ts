import njwt from "njwt";
import { storageSigningKey } from "./signing-key.js";
import { isSafeSegment } from "./storage-key.js";

/** Claims of the repo-scoped storage token the app issues to a client. */
export interface RepoTokenClaims {
  iss: string;
  sub: string;
  userId: string;
  orgId: string;
  repoId: string;
  mode: "read" | "write";
  basePath: string;
}

export type RepoTokenResult =
  | { ok: true; claims: RepoTokenClaims; basePath: string }
  | { ok: false; status: number; message: string };

/**
 * Verifies the Authorization header of a control-plane request (/submit,
 * /repo-size). The gateway has its own check because it also has to scope a
 * request path.
 *
 * A token that merely verifies is not enough. The same key signs the app's
 * system tokens, which carry no repo at all, and read tokens must not be able
 * to do what write tokens do.
 */
export function verifyRepoToken(
  authorizationHeader: string | undefined,
  requireWrite: boolean,
): RepoTokenResult {
  if (!authorizationHeader) {
    return { ok: false, status: 401, message: "Unauthorized" };
  }
  const [type, token] = authorizationHeader.split(" ");
  if (type !== "Bearer" || !token) {
    return { ok: false, status: 401, message: "Unauthorized" };
  }

  let claims: RepoTokenClaims;
  try {
    const verified = njwt.verify(token, storageSigningKey());
    claims = verified!.body.toJSON() as unknown as RepoTokenClaims;
  } catch {
    return { ok: false, status: 401, message: "Unauthorized" };
  }

  if (claims.iss !== "checkpoint-vcs") {
    return { ok: false, status: 403, message: "Forbidden: Wrong token issuer" };
  }
  if (claims.mode !== "read" && claims.mode !== "write") {
    return { ok: false, status: 403, message: "Forbidden: Invalid token mode" };
  }
  if (requireWrite && claims.mode !== "write") {
    return {
      ok: false,
      status: 403,
      message: "Forbidden: Write permission required",
    };
  }
  if (
    typeof claims.orgId !== "string" ||
    typeof claims.repoId !== "string" ||
    !isSafeSegment(claims.orgId) ||
    !isSafeSegment(claims.repoId)
  ) {
    return {
      ok: false,
      status: 403,
      message: "Forbidden: Invalid token scope",
    };
  }

  return {
    ok: true,
    claims,
    basePath: `/${claims.orgId}/${claims.repoId}`,
  };
}
