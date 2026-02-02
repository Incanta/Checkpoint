import config from "@incanta/config";
import njwt from "njwt";

interface SystemJWTClaims {
  iss: string;
  system: boolean;
  action: string;
  path: string;
}

/**
 * Creates a system JWT token for making authorized requests to the Bun storage server.
 * These tokens have a special `system: true` claim that indicates they are from the API server.
 */
export function createSystemToken(action: string, path: string): string {
  const token = njwt.create(
    {
      iss: "checkpoint-api",
      system: true,
      action,
      path,
    } satisfies SystemJWTClaims,
    config.get<string>("storage.signing-keys.system"),
  );

  token.setExpiration(
    Date.now() + config.get<number>("storage.token-expiration-seconds") * 1000,
  );

  return token.compact();
}

/**
 * Creates a directory in the storage backend (SeaweedFS via Bun server).
 * Used during org and repo creation to set up the directory structure.
 */
export async function createStorageDirectory(path: string): Promise<void> {
  const backendUrl = config.get<string>("storage.backend-url");
  const token = createSystemToken("mkdir", path);

  let response: Response;
  for (let attempt = 0; attempt < 3; attempt++) {
    response = await fetch(`${backendUrl}/system/mkdir`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path }),
    });

    if (response.ok) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
  }

  const errorText = await response!.text();
  throw new Error(`Failed to create storage directory ${path}: ${errorText}`);
}

/**
 * Creates the organization directory in storage.
 * Path format: /{orgId}
 */
export async function createOrgDirectory(orgId: string): Promise<void> {
  await createStorageDirectory(`/${orgId}`);
}

/**
 * Creates the repository directory in storage.
 * Path format: /{orgId}/{repoId}
 */
export async function createRepoDirectory(
  orgId: string,
  repoId: string,
): Promise<void> {
  await createStorageDirectory(`/${orgId}/${repoId}`);
}
