import type { Decoded } from "@redwoodjs/api";
import { AuthenticationError, ForbiddenError } from "@redwoodjs/graphql-server";
import { db } from "./db";
import Session from "supertokens-node/recipe/session";
import supertokens from "supertokens-node";
import config from "@incanta/config";

/**
 * Represents the user attributes returned by the decoding the
 * Authentication provider's JWT together with an optional list of roles.
 */
export type RedwoodUser = {
  id: string;
  username: string;
  name: string;
  email: string;
  checkpointAdmin?: boolean;
};

export async function authDecoder(token: string, type: string): Promise<Decoded | null> {
  if(type !== "api-token") {
    return null;
  }

  const { jwtVerify } = await import("jose");

  const signingKey = await config.getWithSecrets<string>("auth.api-tokens.signing-key");
  const secret = new TextEncoder().encode(signingKey);

  const decoded = await jwtVerify(token, secret);

  return decoded.payload;
}

/**
 * getCurrentUser returns the user information together with
 * an optional collection of roles used by requireAuth() to check
 * if the user is authenticated or has role-based access
 *
 * !! BEWARE !! Anything returned from this function will be available to the
 * client--it becomes the content of `currentUser` on the web side (as well as
 * `context.currentUser` on the api side). You should carefully add additional
 * fields to the return object only once you've decided they are safe to be seen
 * if someone were to open the Web Inspector in their browser.
 *
 * @see https://github.com/redwoodjs/redwood/tree/main/packages/auth for examples
 *
 * @param decoded - The decoded access token containing user info and JWT
 *   claims like `sub`. Note, this could be null.
 * @param { token, SupportedAuthTypes type } - The access token itself as well
 *   as the auth provider type
 * @param { APIGatewayEvent event, Context context } - An optional object which
 *   contains information from the invoker such as headers and cookies, and the
 *   context information about the invocation such as IP Address
 * @returns RedwoodUser
 */
export const getCurrentUser = async (
  decoded: Decoded,
  jwt: { schema: string; token: string; type: string },
): Promise<RedwoodUser | null> => {
  if (!decoded) {
    console.warn("No decoded token found, user is not authenticated.");
    return null;
  }

  let user: RedwoodUser | null = null;

  if (jwt.type === "supertokens") {
    const sessionInfo = await Session.getSessionInformation(decoded.sessionHandle as string);
    const userResult = await supertokens.getUsersNewestFirst({
      tenantId: sessionInfo.tenantId,
      query: {
        userId: sessionInfo.userId,
      }
    });

    if (userResult.users.length === 0) {
      console.warn("No user found for session:", sessionInfo);
      return null;
    }

    const email = userResult.users[0].user?.email as string;

    if (!email) {
      console.warn("No email found for user:", userResult.users[0]);
      return null;
    }

    user = await db.user.findUnique({
      where: {
        email,
      },
    });

    if (!user) {
      user = await db.user.create({
        data: {
          name: email,
          username: email,
          email,
        },
      });
    }
  } else if (jwt.type === "api-token") {
    // For API tokens, we assume the email is stored in the decoded token
  }

  if (!user) {
    return null;
  }

  const result: RedwoodUser = {
    id: user.id,
    username: user.username,
    name: user.name,
    email: user.email,
    checkpointAdmin: user.checkpointAdmin,
  };

  if (!result.checkpointAdmin) {
    delete result.checkpointAdmin;
  }

  return result;
};

/**
 * The user is authenticated if there is a currentUser in the context
 *
 * @returns {boolean} - If the currentUser is authenticated
 */
export const isAuthenticated = (context?: Record<string, unknown>): boolean => {
  return !!context?.currentUser;
};

/**
 * When checking role membership, roles can be a single value, a list, or none.
 * You can use Prisma enums too (if you're using them for roles), just import your enum type from `@prisma/client`
 */
type AllowedRoles = string | string[] | undefined;

/**
 * Checks if the currentUser is authenticated (and assigned one of the given roles)
 *
 * @param roles: {@link AllowedRoles} - Checks if the currentUser is assigned one of these roles
 *
 * @returns {boolean} - Returns true if the currentUser is logged in and assigned one of the given roles,
 * or when no roles are provided to check against. Otherwise returns false.
 */
export const hasRole = (roles: AllowedRoles, context?: Record<string, unknown>): boolean => {
  if (!isAuthenticated(context)) {
    return false;
  }

  // we don't use this function

  // const currentUserRoles = (context.currentUser as RedwoodUser)?.roles;

  // if (typeof roles === "string") {
  //   if (typeof currentUserRoles === "string") {
  //     // roles to check is a string, currentUser.roles is a string
  //     return currentUserRoles === roles;
  //   } else if (Array.isArray(currentUserRoles)) {
  //     // roles to check is a string, currentUser.roles is an array
  //     return currentUserRoles?.some((allowedRole) => roles === allowedRole);
  //   }
  // }

  // if (Array.isArray(roles)) {
  //   if (Array.isArray(currentUserRoles)) {
  //     // roles to check is an array, currentUser.roles is an array
  //     return currentUserRoles?.some((allowedRole) =>
  //       roles.includes(allowedRole),
  //     );
  //   } else if (typeof currentUserRoles === "string") {
  //     // roles to check is an array, currentUser.roles is a string
  //     return roles.some((allowedRole) => currentUserRoles === allowedRole);
  //   }
  // }

  // roles not found
  return false;
};

/**
 * Use requireAuth in your services to check that a user is logged in,
 * whether or not they are assigned a role, and optionally raise an
 * error if they're not.
 *
 * @param roles?: {@link AllowedRoles} - When checking role membership, these roles grant access.
 *
 * @returns - If the currentUser is authenticated (and assigned one of the given roles)
 *
 * @throws {@link AuthenticationError} - If the currentUser is not authenticated
 * @throws {@link ForbiddenError} - If the currentUser is not allowed due to role permissions
 *
 * @see https://github.com/redwoodjs/redwood/tree/main/packages/auth for examples
 */
export const requireAuth = ({ roles, context }: { roles?: AllowedRoles, context?: Record<string, unknown> } = {}) => {
  if (!isAuthenticated(context)) {
    throw new AuthenticationError("You don't have permission to do that.");
  }

  if (roles && !hasRole(roles, context)) {
    throw new ForbiddenError("You don't have access to do that.");
  }
};
