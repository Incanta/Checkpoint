import config from "@incanta/config";
import { routes } from "./routes";

const port = config.get<number>("server.port");

Bun.serve({
  port,
  routes: routes(),
});

console.log(`Server listening on port ${port}`);
console.log("[healthy] Server is ready");
