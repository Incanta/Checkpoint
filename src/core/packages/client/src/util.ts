import { exec as nativeExec } from "child_process";
import { promisify } from "util";
import path from "path";
import { promises as fs } from "fs";

export async function getGitRoot(directory: string): Promise<string> {
  // find the .git directory in any parent directory
  const dirParts = directory.split(path.sep);
  while (dirParts.length > 0) {
    try {
      await fs.stat(path.join(...dirParts, ".git"));
      break;
    } catch (e) {
      dirParts.pop();
    }
  }

  if (dirParts.length === 0) {
    throw new Error("Could not find Git repository");
  }

  const gitDir = path.join(...dirParts);
  return gitDir;
}

export async function exec(
  command: string,
  cwd: string | null = null
): Promise<{ stdout: string; stderr: string; code: number }> {
  const exec = promisify(nativeExec);
  let result: { stdout: string; stderr: string; code: number } = {
    stdout: "",
    stderr: "",
    code: 0,
  };

  try {
    const r = await exec(command, {
      cwd: cwd || process.cwd(),
    });
    result = { stdout: r.stdout, stderr: r.stderr, code: 0 };
  } catch (e: any) {
    result.code = e.code;
  }

  return result;
}
