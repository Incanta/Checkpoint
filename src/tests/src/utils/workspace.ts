import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { randomBytes } from "crypto";

export interface TestWorkspace {
  path: string;
  name: string;
  cleanup: () => Promise<void>;
}

/**
 * Create a temporary test workspace directory
 */
export async function createTestWorkspace(
  name?: string,
): Promise<TestWorkspace> {
  const workspaceName =
    name ?? `test-workspace-${randomBytes(6).toString("hex")}`;
  const workspacePath = path.join(
    os.tmpdir(),
    "checkpoint-tests",
    workspaceName,
  );

  await fs.mkdir(workspacePath, { recursive: true });

  return {
    path: workspacePath,
    name: workspaceName,
    cleanup: async () => {
      try {
        await fs.rm(workspacePath, { recursive: true, force: true });
      } catch (error) {
        console.warn(`Failed to cleanup workspace ${workspacePath}:`, error);
      }
    },
  };
}

/**
 * Create a file in the workspace
 */
export async function createTestFile(
  workspace: TestWorkspace,
  relativePath: string,
  content: string | Buffer,
): Promise<string> {
  const fullPath = path.join(workspace.path, relativePath);
  const dir = path.dirname(fullPath);

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(fullPath, content);

  return fullPath;
}

/**
 * Read a file from the workspace
 */
export async function readTestFile(
  workspace: TestWorkspace,
  relativePath: string,
): Promise<string> {
  const fullPath = path.join(workspace.path, relativePath);
  return fs.readFile(fullPath, "utf-8");
}

/**
 * List files in the workspace
 */
export async function listTestFiles(
  workspace: TestWorkspace,
  relativePath: string = "",
): Promise<string[]> {
  const fullPath = path.join(workspace.path, relativePath);
  const entries = await fs.readdir(fullPath, {
    withFileTypes: true,
    recursive: true,
  });

  return entries
    .filter(
      (e) =>
        e.isFile() &&
        e.name !== ".checkpoint" &&
        e.name !== "node_modules" &&
        !e.parentPath.includes(".checkpoint") &&
        !e.parentPath.includes("node_modules"),
    )
    .map((e) =>
      path.relative(workspace.path, path.join(e.parentPath ?? e.path, e.name)),
    );
}

/**
 * Delete a file from the workspace
 */
export async function deleteTestFile(
  workspace: TestWorkspace,
  relativePath: string,
): Promise<void> {
  const fullPath = path.join(workspace.path, relativePath);
  await fs.rm(fullPath);
}

/**
 * Generate random content of a given size
 */
export function generateRandomContent(sizeInBytes: number): Buffer {
  return randomBytes(sizeInBytes);
}

/**
 * Generate a random text file content
 */
export function generateTextContent(lines: number = 100): string {
  const words = [
    "lorem",
    "ipsum",
    "dolor",
    "sit",
    "amet",
    "consectetur",
    "adipiscing",
    "elit",
  ];

  return Array.from({ length: lines }, () => {
    const lineWords = Array.from(
      { length: Math.floor(Math.random() * 10) + 5 },
      () => words[Math.floor(Math.random() * words.length)],
    );
    return lineWords.join(" ");
  }).join("\n");
}
