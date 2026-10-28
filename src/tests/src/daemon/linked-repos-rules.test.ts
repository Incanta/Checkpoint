/**
 * The rules behind Team Sync's linked repos (src/core/daemon/src/util/team-sync/
 * linked-repos.ts): which choice a workspace has for a link, and what a sync
 * of the parent does with it. Pure functions, so every case runs without
 * workspaces; the end-to-end behavior is in linked-repos.test.ts.
 */
import { describe, expect, it } from "vitest";
import type { TeamSyncLinkedRepo, TeamSyncPreset } from "@checkpointvcs/common";

import {
  decideLinkSync,
  resolveLinkChoice,
  selectedPreset,
  type LinkedWorkspaceFacts,
  type ResolvedLinkChoice,
} from "../../../core/daemon/src/util/team-sync/linked-repos.js";

const link = (over: Partial<TeamSyncLinkedRepo> = {}): TeamSyncLinkedRepo => ({
  repo: "UE5",
  branch: "main",
  changelist: 10,
  enabledByDefault: true,
  ...over,
});

const preset = (over: Partial<TeamSyncPreset>): TeamSyncPreset => ({
  name: "p",
  default: false,
  locked: false,
  categories: {},
  buildSteps: {},
  ...over,
});

const facts = (over: Partial<LinkedWorkspaceFacts> = {}): LinkedWorkspaceFacts => ({
  repoName: "UE5",
  orgId: "org",
  domainBranchName: "main",
  activeBranches: [],
  changelistNumber: 5,
  hasLocalChanges: false,
  busy: false,
  otherHolder: null,
  ...over,
});

const follow: ResolvedLinkChoice = {
  mode: "follow-pin",
  workspaceId: "ws-engine",
  source: "workspace",
};

const holder = {
  workspaceId: "ws-other-game",
  workspaceName: "OtherGame",
  localPath: "/games/other",
  changelist: 5,
  at: "x",
};

describe("resolveLinkChoice", () => {
  it("uses the workspace's own entry first", () => {
    expect(
      resolveLinkChoice(
        link(),
        {
          linkedWorkspaces: { UE5: { mode: "manual", workspaceId: "ws-1" } },
          preset: "Artist",
        },
        [preset({ name: "Artist", linkedRepos: { UE5: "ignore" } })],
      ),
    ).toEqual({ mode: "manual", workspaceId: "ws-1", source: "workspace" });
  });

  it("matches the entry and the preset key regardless of case", () => {
    expect(
      resolveLinkChoice(
        link(),
        { linkedWorkspaces: { ue5: { mode: "ignore" } } },
        [],
      ).mode,
    ).toBe("ignore");
    expect(
      resolveLinkChoice(link(), { preset: "A" }, [
        preset({ name: "A", linkedRepos: { ue5: "ignore" } }),
      ]),
    ).toEqual({ mode: "ignore", source: "preset" });
  });

  it("falls back to the selected preset, which names no workspace", () => {
    expect(
      resolveLinkChoice(link(), { preset: "Programmer" }, [
        preset({ name: "Programmer", linkedRepos: { UE5: "follow-pin" } }),
      ]),
    ).toEqual({ mode: "follow-pin", source: "preset" });
  });

  it("uses the repo's default preset when the workspace never chose one", () => {
    const presets = [
      preset({ name: "Artist", default: true, linkedRepos: { UE5: "ignore" } }),
    ];
    expect(resolveLinkChoice(link(), {}, presets).mode).toBe("ignore");
    expect(resolveLinkChoice(link(), undefined, presets).mode).toBe("ignore");
  });

  it("applies no preset when the workspace chose Custom (null)", () => {
    const presets = [
      preset({ name: "Artist", default: true, linkedRepos: { UE5: "ignore" } }),
    ];
    expect(resolveLinkChoice(link(), { preset: null }, presets)).toEqual({
      mode: "follow-pin",
      source: "default",
    });
  });

  it("ignores a preset that does not mention the link", () => {
    expect(
      resolveLinkChoice(link(), { preset: "Artist" }, [
        preset({ name: "Artist", linkedRepos: { Art: "ignore" } }),
      ]).source,
    ).toBe("default");
  });

  it("tolerates presets from older servers with no linkedRepos field", () => {
    const old = preset({ name: "Old", default: true });
    delete (old as Partial<TeamSyncPreset>).linkedRepos;
    expect(resolveLinkChoice(link(), {}, [old]).source).toBe("default");
  });

  it("defaults a nested link to its enabledByDefault", () => {
    expect(
      resolveLinkChoice(link({ path: "Art", enabledByDefault: false }), {}, [])
        .mode,
    ).toBe("ignore");
    expect(
      resolveLinkChoice(link({ path: "Art", enabledByDefault: true }), {}, [])
        .mode,
    ).toBe("follow-pin");
  });
});

describe("selectedPreset", () => {
  const presets = [preset({ name: "A" }), preset({ name: "B", default: true })];
  it("picks the named preset, the default, or none", () => {
    expect(selectedPreset(presets, { preset: "A" })?.name).toBe("A");
    expect(selectedPreset(presets, {})?.name).toBe("B");
    expect(selectedPreset(presets, { preset: null })).toBeUndefined();
    expect(selectedPreset(presets, { preset: "gone" })).toBeUndefined();
  });
});

describe("decideLinkSync", () => {
  const decide = (
    over: {
      link?: Partial<TeamSyncLinkedRepo>;
      choice?: Partial<ResolvedLinkChoice>;
      facts?: Partial<LinkedWorkspaceFacts> | null | "missing";
      confirmed?: boolean;
    } = {},
  ) =>
    decideLinkSync(
      link(over.link),
      { ...follow, ...over.choice },
      "org",
      over.facts === null || over.facts === "missing"
        ? over.facts
        : facts(over.facts),
      over.confirmed ?? false,
    );

  it("syncs a followed workspace that is behind the pin", () => {
    expect(decide()).toEqual({ action: "sync" });
  });

  it("does nothing for a workspace already at the pin, in any mode", () => {
    for (const mode of ["follow-pin", "manual"] as const) {
      expect(decide({ choice: { mode }, facts: { changelistNumber: 10 } })).toEqual(
        { action: "report", status: "up-to-date" },
      );
    }
  });

  it("reports, never syncs, in manual mode", () => {
    expect(decide({ choice: { mode: "manual" } })).toEqual({
      action: "report",
      status: "out-of-date",
    });
    // Even with reasons that would otherwise ask first.
    expect(
      decide({
        choice: { mode: "manual" },
        facts: { hasLocalChanges: true, changelistNumber: 20 },
      }),
    ).toEqual({ action: "report", status: "out-of-date" });
  });

  it("leaves an ignored link alone without looking at any workspace", () => {
    expect(decide({ choice: { mode: "ignore" }, facts: null })).toEqual({
      action: "report",
      status: "ignored",
    });
  });

  it("reports a link with no workspace chosen as not set up", () => {
    expect(decide({ choice: { workspaceId: undefined }, facts: null })).toEqual({
      action: "report",
      status: "not-set-up",
    });
  });

  it("reports nested links as unsupported, whatever the choice", () => {
    expect(decide({ link: { path: "Plugins/Shared" } }).action).toBe("report");
    expect(decide({ link: { path: "Plugins/Shared" } })).toEqual({
      action: "report",
      status: "unsupported",
    });
  });

  it("reports a chosen workspace this daemon does not have", () => {
    expect(decide({ facts: "missing" })).toEqual({
      action: "report",
      status: "missing-workspace",
    });
  });

  it("refuses a workspace of another repo or another org", () => {
    expect(decide({ facts: { repoName: "Game" } })).toEqual({
      action: "report",
      status: "wrong-repo",
    });
    expect(decide({ facts: { orgId: "other-org" } })).toEqual({
      action: "report",
      status: "wrong-repo",
    });
    // Repo names compare without case.
    expect(decide({ facts: { repoName: "ue5" } })).toEqual({ action: "sync" });
  });

  it("refuses a workspace on another branch", () => {
    expect(decide({ facts: { domainBranchName: "release" } })).toEqual({
      action: "report",
      status: "wrong-branch",
    });
  });

  it("never moves a workspace with feature branches overlaid", () => {
    expect(decide({ facts: { activeBranches: ["feature/x"] } })).toEqual({
      action: "report",
      status: "overlay-active",
    });
  });

  it("skips a busy workspace rather than racing its operation", () => {
    expect(decide({ facts: { busy: true } })).toEqual({
      action: "report",
      status: "busy",
    });
  });

  it("asks before moving a workspace with local changes", () => {
    expect(decide({ facts: { hasLocalChanges: true } })).toEqual({
      action: "confirm",
      reasons: ["local-changes"],
    });
  });

  it("asks before moving a workspace back from ahead of the pin", () => {
    expect(decide({ facts: { changelistNumber: 11 } })).toEqual({
      action: "confirm",
      reasons: ["ahead-of-pin"],
    });
  });

  it("asks before moving a workspace another parent holds", () => {
    expect(decide({ facts: { otherHolder: holder } })).toEqual({
      action: "confirm",
      reasons: ["held-by-other"],
    });
  });

  it("lists every reason at once", () => {
    expect(
      decide({
        facts: { hasLocalChanges: true, changelistNumber: 50, otherHolder: holder },
      }),
    ).toEqual({
      action: "confirm",
      reasons: ["local-changes", "ahead-of-pin", "held-by-other"],
    });
  });

  it("syncs once confirmed", () => {
    expect(
      decide({
        facts: { hasLocalChanges: true, changelistNumber: 50, otherHolder: holder },
        confirmed: true,
      }),
    ).toEqual({ action: "sync" });
  });

  it("checks configuration problems before confirmation", () => {
    // Confirming cannot make the wrong repo right.
    expect(
      decide({ facts: { repoName: "Game", hasLocalChanges: true }, confirmed: true }),
    ).toEqual({ action: "report", status: "wrong-repo" });
  });

  it("treats pin 0 like any other pin", () => {
    expect(
      decide({ link: { changelist: 0 }, facts: { changelistNumber: 0 } }),
    ).toEqual({ action: "report", status: "up-to-date" });
    expect(
      decide({ link: { changelist: 0 }, facts: { changelistNumber: 3 } }),
    ).toEqual({ action: "confirm", reasons: ["ahead-of-pin"] });
  });
});
