import { describe, test, expect } from "@jest/globals";
import path from "path";
import { pull } from "../pull";
import { TestClient } from "./test-client";
import { createRepo } from "../create-repo";

describe.skip("create", () => {
  test("it creates a repo", async () => {
    const client = new TestClient(path.join(__dirname, "download"));

    await createRepo(client);
  });
});
