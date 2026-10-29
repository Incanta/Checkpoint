/**
 * Artifact channels in `teamsync.yaml` (the app's zod schema in
 * src/app/src/server/team-sync/config-schema.ts): the include and exclude
 * patterns `checkpoint artifact upload --type` collects files by.
 */
import { describe, expect, it } from "vitest";

import { parseTeamSyncConfig } from "~/server/team-sync/config";

const parse = (channels: string) =>
  parseTeamSyncConfig(`version: 1\nartifacts:\n${channels}\n`, 1);

describe("teamsync.yaml artifact channels", () => {
  it("defaults include and exclude to empty", () => {
    const result = parse("  - type: editor");
    expect(result.errors).toBeNull();
    expect(result.config?.artifacts[0]).toMatchObject({
      type: "editor",
      requiredBadges: [],
      include: [],
      exclude: [],
    });
  });

  it("keeps the patterns as written", () => {
    const result = parse(
      [
        "  - type: editor",
        "    include: [Engine/Binaries/Win64/, 'Engine/Plugins/**/Binaries/Win64/']",
        "    exclude: ['*.pdb']",
      ].join("\n"),
    );
    expect(result.errors).toBeNull();
    expect(result.config?.artifacts[0]).toMatchObject({
      include: ["Engine/Binaries/Win64/", "Engine/Plugins/**/Binaries/Win64/"],
      exclude: ["*.pdb"],
    });
  });

  it.each([
    ["a backslash in include", "    include: ['Engine\\\\Binaries\\\\']"],
    ["a backslash in exclude", "    exclude: ['Binaries\\\\*.pdb']"],
    ["an empty pattern", "    include: ['']"],
  ])("rejects %s", (_name, extra) => {
    const result = parse(`  - type: editor\n${extra}`);
    expect(result.config).toBeNull();
    expect(result.errors).not.toBeNull();
  });
});
