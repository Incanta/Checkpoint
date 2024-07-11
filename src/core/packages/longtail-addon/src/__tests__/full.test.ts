import { describe, test, expect } from "@jest/globals";
import path from "path";
import { pull } from "../client/pull";
import { TestClientFull } from "./test-client-full";
import { createRepo } from "../server/create-repo";
import { commit } from "../client/commit";
import { Operation } from "../types/modification";
import { nanoid } from "nanoid";
import { TestServerFull } from "./test-server-full";

/**
 * server needs to be able to:
 * - create a repo
 * - receive a commit
 * - server a pull request
 */

/**
 * client needs to be able to:
 * - pull from a server
 * - commit to a server
 */

describe("full workflow", () => {
  const server = new TestServerFull(path.join(__dirname, "repos"));
  const client = new TestClientFull(path.join(__dirname, "repos"), server);

  const sourceDirectory = "source";
  const pullDirectory = "pull";

  const file1Name = "file1";
  const file1Contents = nanoid(10);
  const file2Name = "file2";
  const file2Contents = nanoid(10);

  test("it runs a simple workflow", async () => {
    // todo: add an api for the client to trigger repo creation
    // rather than the server just doing it here
    await createRepo(server);

    await pull(client, "0", sourceDirectory);

    const storage = client.getStorageApi();

    const dirResult = storage.CreateDir(sourceDirectory);
    expect(dirResult.error).toBe(0);

    const file1 = storage.OpenWriteFile(`${sourceDirectory}/${file1Name}`);
    expect(file1.error).toBe(0);
    storage.Write(file1.file, 0, file1Contents);
    storage.CloseFile(file1.file);

    const file2 = storage.OpenWriteFile(`${sourceDirectory}/${file2Name}`);
    expect(file2.error).toBe(0);
    storage.Write(file2.file, 0, file2Contents);
    storage.CloseFile(file2.file);

    await commit(client, "1", sourceDirectory, [
      {
        path: file1Name,
        operation: Operation.Add,
        permissions: 0o644,
        isDirectory: false,
      },
    ]);

    await pull(client, "1", pullDirectory);

    expect(storage.IsDir(pullDirectory)).toBe(true);
    expect(storage.IsFile(`${pullDirectory}/file1`)).toBe(true);
    expect(storage.IsFile(`${pullDirectory}/file2`)).toBe(false);

    const fileResult = storage.OpenReadFile(`${pullDirectory}/file1`);
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
    expect(fileReadResult.contents).toBe(file1Contents);
  });
});
