import { Router } from "express";
import config from "@incanta/config";

export function routeFiler(): Router {
  const router = Router();

  router.get("/filer-url", async (_req, res) => {
    const filerUrl = `http${
      config.get<boolean>("seaweedfs.connection.filer.tls") ? "s" : ""
    }://${config.get<string>(
      "seaweedfs.connection.filer.host",
    )}:${config.get<string>("seaweedfs.connection.filer.port")}`;

    res.status(200).send(filerUrl);
  });

  return router;
}
