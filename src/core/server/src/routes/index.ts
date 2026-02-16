import { Router } from "express";
import { routeRoot } from "./root.js";
import { routeSubmit } from "./submit.js";
import { routeFiler } from "./filer.js";
import { routeSystem } from "./system.js";

export function routes(): Router {
  const router = Router();

  router.use(routeRoot());
  router.use(routeSubmit());
  router.use(routeFiler());
  router.use(routeSystem());

  return router;
}
