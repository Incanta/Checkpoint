import type { Endpoint } from ".";

export function routeRoot(): Record<string, Endpoint> {
  return {
    "/": {
      GET: async (request: Request): Promise<typeof Response> => {
        return new Response(null, { status: 200 });
      },
    },
  };
}
