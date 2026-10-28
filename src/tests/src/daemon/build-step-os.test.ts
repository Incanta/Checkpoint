/**
 * Build steps limited to some host OSes with `ifOs`
 * (src/core/daemon/src/util/build/steps.ts and the filter in executor.ts):
 * a step for another OS is skipped, and a step that requires it treats the
 * requirement as satisfied.
 */
import { describe, expect, it } from "vitest";
import type { TeamSyncBuildStep } from "@checkpointvcs/common";

import {
  hostOs,
  stepRunsOn,
  topoSortSteps,
} from "../../../core/daemon/src/util/build/steps.js";

const step = (
  id: string,
  over: Partial<TeamSyncBuildStep> = {},
): TeamSyncBuildStep => ({
  id,
  name: id,
  type: "command",
  command: "true",
  requires: [],
  normalSync: true,
  scheduledSync: false,
  ...over,
});

describe("hostOs", () => {
  it("names the three platforms ifOs knows, and nothing else", () => {
    expect(hostOs("win32")).toBe("windows");
    expect(hostOs("darwin")).toBe("macos");
    expect(hostOs("linux")).toBe("linux");
    expect(hostOs("freebsd")).toBeNull();
    expect(hostOs("aix")).toBeNull();
  });

  it("describes the machine the tests run on", () => {
    expect(hostOs()).toBe(hostOs(process.platform));
  });
});

describe("stepRunsOn", () => {
  it("runs a step without ifOs everywhere, including unnamed platforms", () => {
    for (const os of ["windows", "macos", "linux", null] as const) {
      expect(stepRunsOn(step("a"), os)).toBe(true);
      expect(stepRunsOn(step("a", { ifOs: [] }), os)).toBe(true);
    }
  });

  it("runs a limited step only on its OSes", () => {
    const unix = step("a", { ifOs: ["macos", "linux"] });
    expect(stepRunsOn(unix, "linux")).toBe(true);
    expect(stepRunsOn(unix, "macos")).toBe(true);
    expect(stepRunsOn(unix, "windows")).toBe(false);
    expect(stepRunsOn(unix, null)).toBe(false);
  });
});

describe("skipping steps for other OSes", () => {
  /** What the executor does: filter by OS, then order. */
  const plan = (steps: TeamSyncBuildStep[], os: "windows" | "linux") =>
    topoSortSteps(steps.filter((s) => stepRunsOn(s, os))).map((s) => s.id);

  const steps = [
    step("register-windows", { ifOs: ["windows"] }),
    step("register-unix", { ifOs: ["macos", "linux"] }),
    step("build", { requires: ["register-windows", "register-unix"] }),
  ];

  it("runs each OS variant where it belongs, before the step that requires both", () => {
    expect(plan(steps, "windows")).toEqual(["register-windows", "build"]);
    expect(plan(steps, "linux")).toEqual(["register-unix", "build"]);
  });
});
