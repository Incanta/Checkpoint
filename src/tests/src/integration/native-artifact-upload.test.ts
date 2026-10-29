/**
 * An artifact upload through the real addon, core server, and app: the
 * addon sends the artifact type and the replace flag with the submit, the
 * core server passes them to `artifact.attachToChangelist`, and the upload
 * lands in that type's set (src/longtail/wrapper/src/exposed/submit.cpp,
 * src/core/server/src/routes/submit.ts).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { SubmitAsyncOptions } from "@checkpointvcs/longtail-addon";

import {
  createContext,
  createWorkspace,
  enabled,
  nativeSubmit,
  write,
  type IntegrationContext,
  type LocalWorkspace,
} from "./harness.js";

/** The options addons after 3.1.0 read for an artifact upload. */
type ArtifactUpload = Partial<SubmitAsyncOptions> & {
  artifactType?: string;
  artifactReplace?: boolean;
};

const add = (filePath: string) => ({ path: filePath, delete: false });

describe.skipIf(!enabled)("native artifact upload", () => {
  let ctx: IntegrationContext;
  let ws: LocalWorkspace | undefined;

  beforeAll(async () => {
    ctx = await createContext("native-artifact-upload");
  });

  afterEach(async () => {
    await ws?.cleanup();
    ws = undefined;
  });

  afterAll(async () => {
    await ws?.cleanup();
  });

  const sets = (changelistNumber: number) =>
    ctx.client.artifact.listSets.query({ repoId: ctx.repoId, changelistNumber });

  it("attaches to the named type, and replaces that set when asked", async () => {
    ws = await createWorkspace(ctx, "artifacts");
    await write(ws, "Source/Main.cpp", "int main() {}\n");
    const source = await nativeSubmit(ctx, ws, [add("Source/Main.cpp")]);
    expect(source.error, source.step).toBe(0);
    const cl = source.changelistNumber!;

    await write(ws, "Binaries/Linux/Server", "server v1\n");
    await write(ws, "Binaries/Linux/Old.so", "old\n");
    await write(ws, "Binaries/Win64/Editor.exe", "editor\n");

    const server = (replace = false): ArtifactUpload => ({
      artifactForChangelistNum: cl,
      artifactType: "server-linux",
      ...(replace && { artifactReplace: true }),
    });

    const first = await nativeSubmit(
      ctx,
      ws,
      [add("Binaries/Linux/Server"), add("Binaries/Linux/Old.so")],
      "server build",
      server(),
    );
    expect(first.error, first.step).toBe(0);
    const editor: ArtifactUpload = {
      artifactForChangelistNum: cl,
      artifactType: "editor",
    };
    const second = await nativeSubmit(
      ctx,
      ws,
      [add("Binaries/Win64/Editor.exe")],
      "editor build",
      editor,
    );
    expect(second.error, second.step).toBe(0);

    const counts = async () =>
      Object.fromEntries((await sets(cl)).map((s) => [s.type, s.fileCount]));
    expect(await counts()).toEqual({ editor: 1, "server-linux": 2 });

    // A rebuild that no longer makes Old.so replaces the server set only.
    await write(ws, "Binaries/Linux/Server", "server v2\n");
    const third = await nativeSubmit(
      ctx,
      ws,
      [add("Binaries/Linux/Server")],
      "server rebuild",
      server(true),
    );
    expect(third.error, third.step).toBe(0);
    expect(await counts()).toEqual({ editor: 1, "server-linux": 1 });
  });

  it("is refused without a type, which has no default", async () => {
    ws = await createWorkspace(ctx, "artifacts-untyped");
    await write(ws, "Source/Main.cpp", "int main() {}\n");
    const source = await nativeSubmit(ctx, ws, [add("Source/Main.cpp")]);
    expect(source.error, source.step).toBe(0);
    const cl = source.changelistNumber!;

    await write(ws, "Binaries/Win64/Editor.exe", "editor\n");
    const untyped = await nativeSubmit(
      ctx,
      ws,
      [add("Binaries/Win64/Editor.exe")],
      "untyped build",
      { artifactForChangelistNum: cl },
    );
    expect(untyped.error).not.toBe(0);
    expect(await sets(cl)).toEqual([]);
  });
});
