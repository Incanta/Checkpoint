// Code vs content changelist classification (UGS PerforceMonitor parity).
// A changelist "has code changes" when any changed path has a code extension;
// everything else counts as content.

/**
 * The extension set used when a repo's config does not override it.
 *
 * Deliberately a single constant list covering common source languages rather
 * than something assembled per-repo: `getChangelistClassification` materializes
 * the default-extension result onto the Changelist row, so a default that
 * varied with the repo's config would invalidate every cached flag whenever
 * that config changed.
 *
 * The handful of Unreal-specific entries at the end cost nothing to carry: a
 * repo with no .usf or .uproject files simply never matches them. Repos wanting
 * different behaviour set `codeExtensions` in their config, which bypasses the
 * cache and classifies per request.
 */
export const DEFAULT_CODE_EXTENSIONS = [
  // C / C++ / Objective-C
  ".c",
  ".cc",
  ".cpp",
  ".cxx",
  ".h",
  ".hpp",
  ".hxx",
  ".inl",
  ".m",
  ".mm",
  // .NET
  ".cs",
  ".csproj",
  ".sln",
  ".fs",
  ".vb",
  // JVM
  ".java",
  ".kt",
  ".scala",
  // Scripting and web
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".py",
  ".rb",
  ".php",
  ".lua",
  ".sh",
  ".ps1",
  // Systems
  ".go",
  ".rs",
  ".swift",
  ".zig",
  // Build and resource definitions
  ".cmake",
  ".gradle",
  ".rc",
  // Unreal
  ".usf",
  ".ush",
  ".uproject",
  ".uplugin",
];

export interface ChangeClassification {
  hasCodeChanges: boolean;
  hasContentChanges: boolean;
}

export function classifyPaths(
  paths: string[],
  codeExtensions?: string[],
): ChangeClassification {
  const extensions = new Set(
    (codeExtensions ?? DEFAULT_CODE_EXTENSIONS).map((ext) =>
      ext.toLowerCase(),
    ),
  );

  let hasCodeChanges = false;
  let hasContentChanges = false;

  for (const path of paths) {
    const dotIndex = path.lastIndexOf(".");
    const ext =
      dotIndex === -1 ? "" : path.slice(dotIndex).toLowerCase();

    if (extensions.has(ext)) {
      hasCodeChanges = true;
    } else {
      hasContentChanges = true;
    }

    if (hasCodeChanges && hasContentChanges) {
      break;
    }
  }

  return { hasCodeChanges, hasContentChanges };
}
