import type { PrismaClient, User } from "@prisma/client";

/**
 * Resolve a `Authorization: Bearer <ApiToken>` header to its owning user.
 * Shared by the tRPC context and the REST CI endpoints so both authenticate
 * service accounts the same way. Returns null when the header is missing or
 * the token is unknown/expired.
 */
export async function resolveBearerUser(
  db: PrismaClient,
  authorization: string | null,
): Promise<User | null> {
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }

  const token = authorization.slice("Bearer ".length).trim();
  if (!token) return null;

  const apiTokenData = await db.apiToken.findUnique({
    where: {
      token,
      OR: [{ expiresAt: null }, { expiresAt: { gte: new Date() } }],
    },
    include: { user: true },
  });

  return apiTokenData?.user ?? null;
}
