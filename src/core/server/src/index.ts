import express from "express";
import config from "@incanta/config";
import { routes } from "./routes/index.js";

const port = config.get<number>("server.port");

const app = express();

app.use(express.json());
app.use(routes());

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
  console.log("[healthy] Server is ready");
});
