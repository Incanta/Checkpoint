import path from "path";
import { promises as fs } from "fs";

/**
 * The subset of a UBT `.target` receipt we care about: the primary launch
 * executable and the full list of build product paths.
 */
export interface TargetReceipt {
  /** Absolute path to the target's primary executable, or null. */
  launch: string | null;
  /** Absolute paths of every build product declared in the receipt. */
  buildProducts: string[];
}

/**
 * Locate and parse the UnrealBuildTool receipt for a compiled target.
 *
 * Development builds write `<Target>.target`; other configurations write
 * `<Target>-<Platform>-<Configuration>.target`. The receipt lives under
 * `<ProjectDir>/Binaries/<Platform>/`. Receipt paths use the `$(EngineDir)`
 * and `$(ProjectDir)` receipt variables, which are substituted here
 * (`$(EngineDir)` resolves to `<engineDir>/Engine`, matching UBT semantics).
 *
 * Defensive by design: returns null when the receipt is absent or unparseable.
 */
export async function readReceipt(
  engineDir: string,
  projectDir: string,
  target: string,
  platform: string,
  configuration: string,
): Promise<TargetReceipt | null> {
  const fileName =
    configuration === "Development"
      ? `${target}.target`
      : `${target}-${platform}-${configuration}.target`;
  const receiptPath = path.join(projectDir, "Binaries", platform, fileName);

  let raw: string;
  try {
    raw = await fs.readFile(receiptPath, "utf-8");
  } catch {
    // No receipt file (target not yet built): not an error.
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as {
      Launch?: unknown;
      BuildProducts?: Array<{ Path?: unknown }>;
    };

    const engineSubdir = path.join(engineDir, "Engine");
    const substitute = (value: string): string =>
      value
        .replace(/\$\(EngineDir\)/gi, engineSubdir)
        .replace(/\$\(ProjectDir\)/gi, projectDir);

    const launch =
      typeof parsed.Launch === "string" ? substitute(parsed.Launch) : null;

    const buildProducts: string[] = [];
    for (const product of parsed.BuildProducts ?? []) {
      if (product && typeof product.Path === "string") {
        buildProducts.push(substitute(product.Path));
      }
    }

    return { launch, buildProducts };
  } catch {
    // Malformed receipt JSON: degrade to null.
    return null;
  }
}
