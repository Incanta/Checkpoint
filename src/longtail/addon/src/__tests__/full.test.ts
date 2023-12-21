import { describe, test, expect } from "@jest/globals";
import path from "path";
import { pull } from "../pull";
import { TestClientFull } from "./test-client-full";
import { createRepo } from "../create-repo";
import { commit } from "../commit";
import { Operation } from "../types/modification";
import { nanoid } from "nanoid";

describe("full workflow", () => {
  const client = new TestClientFull(path.join(__dirname, "download"));

  const sourceDirectory = "source";
  const pullDirectory = "pull";

  const file1Contents = nanoid(10);
  const file2Contents = nanoid(10);

  test("it runs a simple workflow", async () => {
    await createRepo(client);

    const storage = client.getStorageApi();

    const dirResult = storage.CreateDir(sourceDirectory);
    expect(dirResult.error).toBe(0);

    const file1 = storage.OpenWriteFile(`${sourceDirectory}/file1`);
    expect(file1.error).toBe(0);
    storage.Write(file1.file, 0, file1Contents);
    storage.CloseFile(file1.file);

    const file2 = storage.OpenWriteFile(`${sourceDirectory}/file2`);
    expect(file2.error).toBe(0);
    storage.Write(file2.file, 0, file2Contents);
    storage.CloseFile(file2.file);

    await commit(client, "1", sourceDirectory, [
      {
        path: "file1",
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
