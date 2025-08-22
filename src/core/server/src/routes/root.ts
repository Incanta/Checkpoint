export function routeRoot() {
  return {
    "/": {
      GET: async (request: Request) => {
        return new Response(null, { status: 200 });
      },
    },
  };
}
