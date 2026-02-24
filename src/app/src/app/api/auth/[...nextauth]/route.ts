import { handlers } from "~/server/auth";
import { type NextRequest } from "next/server";

/**
 * Next.js dev server binds to localhost, so req.url uses localhost as the origin
 * even when accessed via a different hostname (e.g. checkpoint.localhost).
 * Auth.js uses req.url to build the OAuth redirect_uri, so we rewrite it to
 * match the Host header so the callback URL sent to the provider is correct.
 */
function withHostRewrite(handler: (req: NextRequest) => Promise<Response>) {
  return async (req: NextRequest) => {
    const host = req.headers.get("host");
    if (host) {
      const proto = req.headers.get("x-forwarded-proto") ?? "http";
      const correctOrigin = `${proto}://${host}`;
      const currentOrigin = new URL(req.url).origin;
      if (currentOrigin !== correctOrigin) {
        const rewrittenUrl = req.url.replace(currentOrigin, correctOrigin);
        req = new Request(rewrittenUrl, req) as unknown as NextRequest;
      }
    }
    return handler(req);
  };
}

export const GET = withHostRewrite(handlers.GET);
export const POST = withHostRewrite(handlers.POST);
