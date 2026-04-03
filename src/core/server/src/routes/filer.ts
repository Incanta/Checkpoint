import { Router } from "express";
import { getFilerUrl } from "../utils/filer.js";

export function routeFiler(): Router {
  const router = Router();

  router.get("/filer-url", async (_req, res) => {
    res.status(200).send(getFilerUrl(false));
  });

  return router;
}
