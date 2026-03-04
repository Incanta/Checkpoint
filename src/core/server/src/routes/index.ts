import { Router } from "express";
import config from "@incanta/config";
import { routeRoot } from "./root.js";
import { routeSubmit } from "./submit.js";
import { routeFiler } from "./filer.js";
import { routeSystem } from "./system.js";
import { routeRepoSize } from "./repo-size.js";
import { routeStubFiler } from "./stub-filer.js";

export function routes(): Router {
  const router = Router();

  router.use(routeRoot());
  router.use(routeSubmit());
  router.use(routeFiler());
  router.use(routeSystem());
  router.use(routeRepoSize());

  if (config.get<boolean>("seaweedfs.stub.enabled")) {
    router.use("/filer", routeStubFiler());
  }

  return router;
}
