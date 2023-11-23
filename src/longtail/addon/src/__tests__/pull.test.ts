import { describe, test, expect } from "@jest/globals";
import path from "path";
import { pull } from "../pull";
import { TestClient } from "./test-client";

describe("pull", () => {
  test("it gets version 1.0.0", async () => {
    const client = new TestClient(path.join(__dirname, "download"));
    await pull(client, "1.0.0", "output");

    const storage = client.getStorageApi();
    expect(storage.IsDir("output")).toBe(true);
    expect(storage.IsFile("output/branch.json")).toBe(true);
    expect(storage.IsFile("output/hello.txt")).toBe(true);
    expect(storage.IsFile("output/notarealfile.txt")).toBe(false);

    const fileResult = storage.OpenReadFile("output/hello.txt");
    expect(fileResult.error).toBe(0);
    const fileSizeResult = storage.GetSize(fileResult.file);
    expect(fileSizeResult.error).toBe(0);
    console.log(fileResult.file);
    const fileReadResult = storage.Read(
      fileResult.file,
      0,
      fileSizeResult.size,
    );
    expect(fileReadResult.error).toBe(0);
    expect(fileReadResult.contents).toBe(
      "aodijfoasijdfoijasdf oaipsjuf poasijdf opaisjdf \n",
    );

    const fileResult2 = storage.OpenReadFile("output/branch.json");
    expect(fileResult2.error).toBe(0);
    const fileSizeResult2 = storage.GetSize(fileResult2.file);
    expect(fileSizeResult2.error).toBe(0);
    const fileReadResult2 = storage.Read(
      fileResult2.file,
      0,
      fileSizeResult2.size,
    );
    expect(fileReadResult2.error).toBe(0);
    expect(fileReadResult2.contents).toBe(
      `{
  "branch": "Test",
  "version": "1.0.0"
}`,
    );
  });
});
