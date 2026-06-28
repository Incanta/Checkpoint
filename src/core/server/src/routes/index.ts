import { Router } from "express";
import { routeRoot } from "./root.js";
import { routeSubmit } from "./submit.js";
import { routeSystem } from "./system.js";
import { routeRepoSize } from "./repo-size.js";
import { routeBlocks } from "./blocks.js";
import { routeGateway } from "./gateway.js";
import { usesGateway } from "../storage/backend.js";

export function routes(): Router {
  const router = Router();

  router.use(routeRoot());
  router.use(routeSubmit());
  router.use(routeSystem());
  // State-tree + content block storage goes through the unified backend.
  router.use(routeBlocks());

  // The client-facing blob gateway and repo-size are only for gateway modes
  // (local / s3). In r2 mode the client talks to R2 directly and repo size
  // comes from the Cloudflare usage API in the app.
  if (usesGateway()) {
    router.use("/storage", routeGateway());
    router.use(routeRepoSize());
  }

  return router;
}
