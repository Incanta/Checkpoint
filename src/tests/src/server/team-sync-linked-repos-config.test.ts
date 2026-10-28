/**
 * Validation of `linkedRepos` in `.checkpoint/teamsync.yaml` (the app's zod
 * schema in src/app/src/server/team-sync/config-schema.ts).
 */
import { describe, expect, it } from "vitest";

import { parseTeamSyncConfig } from "~/server/team-sync/config";

const parse = (yaml: string) => parseTeamSyncConfig(yaml, 1);

describe("teamsync.yaml linkedRepos", () => {
  it("defaults to no links, and presets to no link modes", () => {
    const result = parse("version: 1\npresets:\n  - name: Artist\n");
    expect(result.errors).toBeNull();
    expect(result.config?.linkedRepos).toEqual([]);
    expect(result.config?.presets[0]?.linkedRepos).toEqual({});
  });

  it("accepts an anywhere-on-disk link and fills in enabledByDefault", () => {
    const result = parse(
      [
        "version: 1",
        "linkedRepos:",
        "  - repo: UE5",
        "    branch: main",
        "    changelist: 48213",
      ].join("\n"),
    );
    expect(result.errors).toBeNull();
    expect(result.config?.linkedRepos).toEqual([
      { repo: "UE5", branch: "main", changelist: 48213, enabledByDefault: true },
    ]);
  });

  it("accepts a nested link with a path", () => {
    const result = parse(
      [
        "version: 1",
        "linkedRepos:",
        "  - repo: StudioArt",
        "    branch: main",
        "    changelist: 9",
        "    path: SourceArt",
        "    enabledByDefault: false",
      ].join("\n"),
    );
    expect(result.errors).toBeNull();
    expect(result.config?.linkedRepos?.[0]).toMatchObject({
      path: "SourceArt",
      enabledByDefault: false,
    });
  });

  it("accepts link modes in presets", () => {
    const result = parse(
      [
        "version: 1",
        "presets:",
        "  - name: Programmer",
        "    linkedRepos:",
        "      StudioArt: ignore",
        "      UE5: follow-pin",
      ].join("\n"),
    );
    expect(result.errors).toBeNull();
    expect(result.config?.presets[0]?.linkedRepos).toEqual({
      StudioArt: "ignore",
      UE5: "follow-pin",
    });
  });

  it.each([
    ["a missing branch", "  - repo: UE5\n    changelist: 1"],
    ["a missing changelist", "  - repo: UE5\n    branch: main"],
    ["a negative changelist", "  - repo: UE5\n    branch: main\n    changelist: -1"],
    ["a fractional changelist", "  - repo: UE5\n    branch: main\n    changelist: 1.5"],
    ["an empty repo name", "  - repo: ''\n    branch: main\n    changelist: 1"],
    [
      "an absolute path",
      "  - repo: Art\n    branch: main\n    changelist: 1\n    path: /SourceArt",
    ],
    [
      "a path leaving the repo",
      "  - repo: Art\n    branch: main\n    changelist: 1\n    path: Plugins/../../x",
    ],
    [
      "a backslash path leaving the repo",
      "  - repo: Art\n    branch: main\n    changelist: 1\n    path: 'Plugins\\..\\..\\x'",
    ],
  ])("rejects %s", (_name, body) => {
    const result = parse(`version: 1\nlinkedRepos:\n${body}\n`);
    expect(result.config).toBeNull();
    expect(result.errors?.length).toBeGreaterThan(0);
  });

  it("rejects linking the same repo twice, even with different case", () => {
    const result = parse(
      [
        "version: 1",
        "linkedRepos:",
        "  - repo: UE5",
        "    branch: main",
        "    changelist: 1",
        "  - repo: ue5",
        "    branch: release",
        "    changelist: 2",
      ].join("\n"),
    );
    expect(result.config).toBeNull();
    expect(result.errors?.join("\n")).toContain("each repo may only be linked once");
  });

  it("rejects an unknown preset link mode", () => {
    const result = parse(
      "version: 1\npresets:\n  - name: A\n    linkedRepos:\n      UE5: sometimes\n",
    );
    expect(result.config).toBeNull();
  });
});
