/**
 * Which linked repo pins a changelist moves (src/app/src/server/team-sync/
 * pin-changes.ts), behind the changelist browser's "update" badge and
 * bisect's warning.
 */
import { describe, expect, it } from "vitest";

import type { TeamSyncConfigResult } from "~/server/team-sync/config-schema";
import {
  comparePinsBetween,
  diffLinkPins,
  pinChangesForChangelists,
} from "~/server/team-sync/pin-changes";

const link = (repo: string, changelist: number, branch = "main") => ({
  repo,
  branch,
  changelist,
});

/** A config result whose only interesting part is its links. */
const result = (
  links: ReturnType<typeof link>[] | null,
  errors: string[] | null = null,
): TeamSyncConfigResult =>
  ({
    config:
      links === null
        ? null
        : {
            linkedRepos: links.map((l) => ({ ...l, enabledByDefault: true })),
          },
    sourceChangelistNumber: links === null ? null : 1,
    errors,
  }) as TeamSyncConfigResult;

/** Answers configs from a changelist -> result map. */
const reader =
  (configs: Record<number, TeamSyncConfigResult>) => async (n: number) => {
    const config = configs[n];
    if (!config) throw new Error(`no config read expected at ${n}`);
    return config;
  };

describe("diffLinkPins", () => {
  it("reports nothing when the pins are the same", () => {
    expect(diffLinkPins([link("UE5", 10)], [link("UE5", 10)])).toEqual([]);
    expect(diffLinkPins(undefined, [])).toEqual([]);
  });

  it("reports a moved changelist and a moved branch", () => {
    expect(diffLinkPins([link("UE5", 10)], [link("UE5", 12)])).toEqual([
      {
        repo: "UE5",
        from: { branch: "main", changelist: 10 },
        to: { branch: "main", changelist: 12 },
      },
    ]);
    expect(
      diffLinkPins([link("UE5", 10)], [link("UE5", 10, "release")]),
    ).toEqual([
      {
        repo: "UE5",
        from: { branch: "main", changelist: 10 },
        to: { branch: "release", changelist: 10 },
      },
    ]);
  });

  it("reports added and removed links", () => {
    expect(
      diffLinkPins([link("Tools", 3)], [link("UE5", 10)]).sort((a, b) =>
        a.repo.localeCompare(b.repo),
      ),
    ).toEqual([
      { repo: "Tools", from: { branch: "main", changelist: 3 }, to: null },
      { repo: "UE5", from: null, to: { branch: "main", changelist: 10 } },
    ]);
  });

  it("matches repo names without case, reporting the new spelling", () => {
    expect(diffLinkPins([link("ue5", 10)], [link("UE5", 10)])).toEqual([]);
    expect(diffLinkPins([link("ue5", 10)], [link("UE5", 11)])[0]?.repo).toBe(
      "UE5",
    );
  });

  it("leaves unchanged links out when another moves", () => {
    const changes = diffLinkPins(
      [link("UE5", 10), link("Tools", 3)],
      [link("UE5", 10), link("Tools", 4)],
    );
    expect(changes.map((c) => c.repo)).toEqual(["Tools"]);
  });
});

describe("comparePinsBetween", () => {
  it("compares the configs at two changelists", async () => {
    const changes = await comparePinsBetween(
      5,
      9,
      reader({ 5: result([link("UE5", 10)]), 9: result([link("UE5", 20)]) }),
    );
    expect(changes).toEqual([
      {
        repo: "UE5",
        from: { branch: "main", changelist: 10 },
        to: { branch: "main", changelist: 20 },
      },
    ]);
  });

  it("treats a missing config as no links", async () => {
    const changes = await comparePinsBetween(
      5,
      9,
      reader({ 5: result(null), 9: result([link("UE5", 20)]) }),
    );
    expect(changes).toEqual([
      { repo: "UE5", from: null, to: { branch: "main", changelist: 20 } },
    ]);
  });

  it("knows nothing when either config is invalid or unreadable", async () => {
    expect(
      await comparePinsBetween(
        5,
        9,
        reader({ 5: result(null, ["bad yaml"]), 9: result([link("UE5", 20)]) }),
      ),
    ).toBeNull();
    expect(
      await comparePinsBetween(5, 9, async () => {
        throw new Error("storage down");
      }),
    ).toBeNull();
  });
});

describe("pinChangesForChangelists", () => {
  it("compares each changelist with its parent and keeps only pin moves", async () => {
    const configs = reader({
      10: result([link("UE5", 100)]),
      11: result([link("UE5", 200)]),
      12: result([link("UE5", 200)]),
      20: result([link("UE5", 200)]),
      21: result([link("UE5", 200), link("Tools", 7)]),
    });
    const changes = await pinChangesForChangelists(
      [
        { number: 11, parentNumber: 10 }, // moves UE5
        { number: 12, parentNumber: 11 }, // edits the file, no pin change
        { number: 21, parentNumber: 20 }, // adds Tools
      ],
      configs,
    );
    expect([...changes.keys()].sort()).toEqual([11, 21]);
    expect(changes.get(11)).toEqual([
      {
        repo: "UE5",
        from: { branch: "main", changelist: 100 },
        to: { branch: "main", changelist: 200 },
      },
    ]);
    expect(changes.get(21)?.map((c) => c.repo)).toEqual(["Tools"]);
  });

  it("treats a changelist with no parent as adding every link", async () => {
    const changes = await pinChangesForChangelists(
      [{ number: 1, parentNumber: null }],
      reader({ 1: result([link("UE5", 100)]) }),
    );
    expect(changes.get(1)).toEqual([
      { repo: "UE5", from: null, to: { branch: "main", changelist: 100 } },
    ]);
  });

  it("leaves out a changelist whose config is invalid, without failing the rest", async () => {
    const changes = await pinChangesForChangelists(
      [
        { number: 11, parentNumber: 10 },
        { number: 13, parentNumber: 12 },
      ],
      reader({
        10: result([link("UE5", 100)]),
        11: result(null, ["linkedRepos.0.changelist: Expected number"]),
        12: result([link("UE5", 100)]),
        13: result([link("UE5", 300)]),
      }),
    );
    expect([...changes.keys()]).toEqual([13]);
  });
});
