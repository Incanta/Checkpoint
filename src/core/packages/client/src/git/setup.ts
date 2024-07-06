import path from "path";
import { existsSync, promises as fs } from "fs";
import { CheckpointConfig } from "../config";
import { exec } from "../util";
import { GetLogger } from "../logging";

export async function InstallFilter(): Promise<void> {
  await exec(
    `git config --global filter.checkpoint.process "git-chk filter-process"`
  );
  await exec(`git config --global filter.checkpoint.required true`);
  await exec(`git config --global filter.checkpoint.clean "git-chk clean %f"`);
  await exec(
    `git config --global filter.checkpoint.smudge "git-chk smudge %f"`
  );
}

export async function MakeHookFile(
  config: CheckpointConfig,
  command: string,
  force: boolean
): Promise<void> {
  const content = `#!/bin/sh\ncommand -v git-chk >/dev/null 2>&1 || { echo >&2 "\\nThis repository is configured for Checkpoint but 'git-chk' was not found on your path. If you no longer wish to use Checkpoint, remove this hook by deleting '.git/hooks/${command}'.\\n"; exit 2; }\ngit chk ${command} "$@"`;

  const hookPath = path.join(config.gitRoot, ".git", "hooks", command);
  if (!force && existsSync(hookPath)) {
    const hookFileContents = await fs.readFile(hookPath, "utf-8");

    if (hookFileContents === content) {
      return;
    }

    GetLogger(config).error(
      `Found existing Git hook at ${hookPath} that contains non-standard Checkpoint content. Please resolve externally or use \`git chk update --force\`.`
    );
    return;
  }

  await fs.writeFile(hookPath, content, {
    mode: 0o755,
  });
}

export async function UpdateGitHooks(
  config: CheckpointConfig,
  force: boolean
): Promise<void> {
  // check if LFS is enabled
  if (existsSync(path.join(config.gitRoot, ".gitattributes"))) {
    // check if any filters use LFS
    const attributes = await fs.readFile(
      path.join(config.gitRoot, ".gitattributes"),
      "utf-8"
    );

    if (attributes.includes("filter=lfs")) {
      GetLogger(config).error(
        "Found Git LFS filters in this Git repository's .gitattributes file. Checkpoint cannot be used alongside Git LFS. Remove the LFS filters and try again."
      );
      process.exit(1);
    }
  }

  await fs.mkdir(path.join(config.gitRoot, ".git", "hooks"), {
    recursive: true,
  });

  await MakeHookFile(config, "post-commit", force);

  GetLogger(config).info("Updated Git hooks.");
}

export async function SetUpGitAttributes(
  config: CheckpointConfig
): Promise<void> {
  const attributesFile = path.join(config.gitRoot, ".gitattributes");

  if (existsSync(attributesFile)) {
    GetLogger(config).info(
      "Found existing .gitattributes file, skipping set up."
    );
    return;
  }

  const commonFilters = [
    "# Unreal Engine",
    "*.umap",
    "*.uasset",

    "# Unity",
    "*.unitypackage",

    "# Images",
    "*.jpg",
    "*.jpeg",
    "*.png",
    "*.gif",
    "*.bmp",
    "*.tiff",
    "*.tif",
    "*.webp",

    "# Videos",
    "*.mp4",
    "*.mov",
    "*.avi",
    "*.mkv",
    "*.webm",
    "*.flv",
    "*.ogg",

    "# Audio",
    "*.mp3",
    "*.wav",
    "*.flac",
    "*.m4a",

    "# 3D Models",
    "*.FBX",
    "*.fbx",
    "*.OBJ",
    "*.obj",
    "*.dae",
    "*.3ds",
    "*.blend",

    "# Containers",
    "*.zip",
    "*.rar",
    "*.7z",
    "*.tar",
    "*.gz",
    "*.bz2",
    "*.xz",
    "*.lz",
    "*.lzma",
    "*.tgz",

    "# Documents",
    "*.psd",
    "*.ai",
    "*.xd",
    "*.afphoto",
    "*.afdesign",
    "*.aftemplate",
    "*.afpub",
    "*.spp",

    "# Compiled",
    "*.exe",
    "*.dll",
    "*.so",
    "*.dylib",
    "*.a",
    "*.lib",
    "*.app",
    "*.apk",
    "*.ipa",
    "*.jar",
  ];

  const content = commonFilters
    .map((s) =>
      s.startsWith("#")
        ? `\n${s}`
        : `${s} filter=checkpoint diff=checkpoint merge=checkpoint -text`
    )
    .join("\n");

  await fs.writeFile(attributesFile, content);
}
