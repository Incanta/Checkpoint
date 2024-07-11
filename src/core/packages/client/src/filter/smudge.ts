import Bun from "bun";
import type { CheckpointConfig } from "../config";
import { ParseVirtualFile, type VirtualFile } from "./virtual-file";
import { GetLogger } from "../logging";

// Smudge takes the virtual file on stdin and pulls the data
// from the checkpoint server, finally writing the binary file
// to stdout
export async function Smudge(
  config: CheckpointConfig,
  file: string
): Promise<void> {
  GetLogger(config).info(`Smudging file ${file}`);

  const virtualFileChunks: string[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    virtualFileChunks.push(Buffer.from(chunk).toString("utf-8"));
  }
  const virtualFile: VirtualFile = ParseVirtualFile(virtualFileChunks.join());

  const writer = Bun.stdout.writer();
  writer.start();

  writer.write(virtualFile.contents);

  writer.end();
}
