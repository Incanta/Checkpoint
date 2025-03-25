import merge from "lodash.merge";
import { routeRoot } from "./root";
import type { BunRequest, RouterTypes, Server } from "bun";

// Bun's types are incomplete
type RouteHandler<T extends string> = (
  req: BunRequest<T> & { json(): Promise<any> },
  server: Server
) => typeof Response | Promise<typeof Response>;
export type Endpoint = {
  [K in RouterTypes.HTTPMethod]?: RouteHandler<string>;
};

export function routes(): Record<string, Endpoint> {
  return merge({}, routeRoot());
}
