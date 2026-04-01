import config from "@incanta/config";

/**
 * Returns the default binary extensions from config.
 */
export function getDefaultBinaryExtensions(): string[] {
  return config.get<string[]>("binary-extensions.defaults");
}

/**
 * Resolves the effective binary extensions set by applying org overrides
 * to the default list. The overrides string is a CSV of "+.ext" and "-.ext"
 * entries processed in order.
 */
export function resolveBinaryExtensions(orgOverrides: string): Set<string> {
  const defaults = getDefaultBinaryExtensions();
  const result = new Set(defaults);

  if (!orgOverrides || orgOverrides.trim() === "") {
    return result;
  }

  const entries = orgOverrides.split(",").map((e) => e.trim()).filter(Boolean);
  for (const entry of entries) {
    if (entry.startsWith("+")) {
      result.add(entry.slice(1));
    } else if (entry.startsWith("-")) {
      result.delete(entry.slice(1));
    }
  }

  return result;
}

/**
 * Checks whether a file path is binary given the resolved extensions set.
 */
export function isBinaryFile(filePath: string, extensions: Set<string>): boolean {
  const ext = filePath.lastIndexOf(".");
  if (ext === -1) return false;
  return extensions.has(filePath.slice(ext).toLowerCase());
}
