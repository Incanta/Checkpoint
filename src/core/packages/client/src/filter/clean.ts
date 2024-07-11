import Bun from "bun";
import type { CheckpointConfig } from "../config";
import {
  StringifyVirtualFile,
  VirtualFileVersion,
  type VirtualFile,
} from "./virtual-file";
import { GetLogger } from "../logging";

// Clean takes the binary data on stdin and uploads it to
// the checkpoint server, finally writing the virtual file
// to stdout.
export async function Clean(
  config: CheckpointConfig,
  file: string
): Promise<void> {
  GetLogger(config).info(`Cleaning file ${file}`);

  const fileChunks: string[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    fileChunks.push(Buffer.from(chunk).toString("utf-8"));
  }
  const virtualFile: VirtualFile = {
    specVersion: VirtualFileVersion,
    contents: fileChunks.join(),
    sizeBytes: fileChunks.join().length,
  };

  const writer = Bun.stdout.writer();
  writer.start();

  writer.write(StringifyVirtualFile(virtualFile));

  writer.end();
}
