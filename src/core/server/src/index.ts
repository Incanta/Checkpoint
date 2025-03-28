import config from "@incanta/config";
import { routes } from "./routes";

Bun.serve({
  port: config.get<number>("server.port"),
  routes: routes(),
});
