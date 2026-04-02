import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "~/server/auth/config";

export const { GET, POST } = toNextJsHandler(async (request) => {
  const authInstance = await auth;
  return authInstance.handler(request);
});
