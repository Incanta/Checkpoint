/**
 * Validation of `ifOs` on build steps in `.checkpoint/teamsync.yaml` (the
 * app's zod schema in src/app/src/server/team-sync/config-schema.ts).
 */
import { describe, expect, it } from "vitest";

import { parseTeamSyncConfig } from "~/server/team-sync/config";

const parse = (steps: string) =>
  parseTeamSyncConfig(`version: 1\nbuildSteps:\n${steps}\n`, 1);

const step = (id: string, extra = "") =>
  `  - id: ${id}\n    name: ${id}\n    command: run${extra}`;

describe("teamsync.yaml build step ifOs", () => {
  it("leaves ifOs out when a step doesn't set it", () => {
    const result = parse(step("a"));
    expect(result.errors).toBeNull();
    expect(result.config?.buildSteps[0]?.ifOs).toBeUndefined();
  });

  it("resolves one OS to a list", () => {
    const result = parse(step("a", "\n    ifOs: windows"));
    expect(result.errors).toBeNull();
    expect(result.config?.buildSteps[0]?.ifOs).toEqual(["windows"]);
  });

  it("keeps a list, without repeats", () => {
    const result = parse(step("a", "\n    ifOs: [macos, linux, macos]"));
    expect(result.errors).toBeNull();
    expect(result.config?.buildSteps[0]?.ifOs).toEqual(["macos", "linux"]);
  });

  it.each([
    ["an unknown OS", "\n    ifOs: win64"],
    ["an unknown OS in a list", "\n    ifOs: [windows, beos]"],
    ["an empty list", "\n    ifOs: []"],
    ["a capitalized OS", "\n    ifOs: Windows"],
  ])("rejects %s", (_name, extra) => {
    const result = parse(step("a", extra));
    expect(result.config).toBeNull();
  });

  it("lets a shared step require OS variants of one step", () => {
    const result = parse(
      [
        step("register-windows", "\n    ifOs: windows"),
        step("register-unix", "\n    ifOs: [macos, linux]"),
        step("build", "\n    requires: [register-windows, register-unix]"),
      ].join("\n"),
    );
    expect(result.errors).toBeNull();
  });

  it("rejects a step requiring a step that never runs on any of its OSes", () => {
    const result = parse(
      [
        step("register-windows", "\n    ifOs: windows"),
        step("mac-only", "\n    ifOs: macos\n    requires: [register-windows]"),
      ].join("\n"),
    );
    expect(result.config).toBeNull();
    expect(result.errors?.join("\n")).toMatch(
      /"mac-only" \(runs on macos\) requires "register-windows", which only runs on windows/,
    );
  });

  it("allows requiring a step that shares at least one OS", () => {
    const result = parse(
      [
        step("unix-setup", "\n    ifOs: [macos, linux]"),
        step("linux-build", "\n    ifOs: linux\n    requires: [unix-setup]"),
      ].join("\n"),
    );
    expect(result.errors).toBeNull();
  });

  it("allows requiring ids it doesn't define, like the Unreal default steps", () => {
    const result = parse(
      step(
        "cook",
        "\n    ifOs: windows\n    requires: [0FA1B2C3-D4E5-6789-ABCD-EF0123456701]",
      ),
    );
    expect(result.errors).toBeNull();
  });
});
