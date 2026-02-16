import { Router } from "express";

export function routeRoot(): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    res.sendStatus(200);
  });

  return router;
}
