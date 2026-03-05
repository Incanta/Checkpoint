import { headers } from "next/headers";
import { cache } from "react";

import { auth } from "./config";
import type { Session } from "./config";

/**
 * Get the current session from better-auth, cached for the request lifetime.
 * Returns a normalized Session object compatible with the rest of the app.
 */
const getSessionUncached = async (): Promise<Session | null> => {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) return null;

  return {
    user: {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      image: session.user.image,
    },
    expires: session.session.expiresAt.toISOString(),
  };
};

const getSession = cache(getSessionUncached);

export { auth, getSession };
export type { Session };
