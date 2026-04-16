import { type Request, type Response } from "express";
import { getDb } from "../db.js";

export async function healthCheck(_req: Request, res: Response): Promise<void> {
  try {
    const db = getDb();
    await db.$queryRaw`SELECT 1`;
    res.json({ status: "healthy" });
  } catch {
    res
      .status(503)
      .json({ status: "unhealthy", error: "Database unreachable" });
  }
}
