// Code vs content changelist classification (UGS PerforceMonitor parity).
// A changelist "has code changes" when any changed path has a code extension;
// everything else counts as content.

export const DEFAULT_CODE_EXTENSIONS = [
  ".c",
  ".cc",
  ".cpp",
  ".m",
  ".mm",
  ".rc",
  ".cs",
  ".csproj",
  ".h",
  ".hpp",
  ".inl",
  ".usf",
  ".ush",
  ".uproject",
  ".uplugin",
  ".sln",
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
