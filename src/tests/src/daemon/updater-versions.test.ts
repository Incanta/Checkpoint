/**
 * Version handling in the daemon auto-updater.
 *
 * These helpers decide whether a machine ever sees a new build, and they fail
 * silently when wrong: a bad comparison just reports "up to date" forever.
 * The nightly channel makes that sharper, because every nightly version is a
 * semver prerelease ("0.5.0-nightly.202609030800.g1a2b3c4d") and the previous
 * numeric-only comparison parsed those as NaN.
 */
import { describe, expect, it } from "vitest";

import {
  compareVersions,
  extractVersionFromFilename,
  pickPendingInstaller,
} from "../../../core/daemon/src/updater.js";

const WINDOWS_PATTERN = "Checkpoint-Windows-x64-.*-Setup\\.exe$";

describe("compareVersions", () => {
  it("orders release versions by numeric core", () => {
    expect(compareVersions("0.4.16", "0.4.15")).toBe(1);
    expect(compareVersions("0.4.15", "0.4.16")).toBe(-1);
    expect(compareVersions("0.4.15", "0.4.15")).toBe(0);
    expect(compareVersions("1.0.0", "0.9.9")).toBe(1);
    expect(compareVersions("0.5.0", "0.4.99")).toBe(1);
  });

  it("tolerates a leading v and ignores build metadata", () => {
    expect(compareVersions("v0.4.16", "0.4.15")).toBe(1);
    expect(compareVersions("0.4.15+build.7", "0.4.15")).toBe(0);
  });

  it("ranks a prerelease below the release it precedes", () => {
    expect(compareVersions("0.4.16-nightly.202609030800", "0.4.16")).toBe(-1);
    expect(compareVersions("0.4.16", "0.4.16-nightly.202609030800")).toBe(1);
  });

  it("ranks a nightly above the release it follows", () => {
    // The whole reason compute-release-version.js bumps the patch: a nightly
    // built after 0.4.15 shipped must read as newer than 0.4.15.
    expect(compareVersions("0.4.16-nightly.202609030800", "0.4.15")).toBe(1);
  });

  it("orders successive nightlies by their timestamp", () => {
    const older = "0.4.16-nightly.202609030800.gaaaaaaaa";
    const newer = "0.4.16-nightly.202609040800.gbbbbbbbb";
    expect(compareVersions(newer, older)).toBe(1);
    expect(compareVersions(older, newer)).toBe(-1);
    expect(compareVersions(older, older)).toBe(0);
  });

  it("compares numeric prerelease identifiers numerically, not as strings", () => {
    expect(compareVersions("1.0.0-alpha.10", "1.0.0-alpha.9")).toBe(1);
  });

  it("ranks numeric prerelease identifiers below alphanumeric ones", () => {
    expect(compareVersions("1.0.0-alpha.1", "1.0.0-alpha.beta")).toBe(-1);
  });

  it("treats a shorter prerelease as lower when the prefix matches", () => {
    expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
  });
});

describe("extractVersionFromFilename", () => {
  it("reads release versions off every installer name", () => {
    expect(
      extractVersionFromFilename("Checkpoint-Windows-x64-0.4.11-Setup.exe"),
    ).toBe("0.4.11");
    expect(
      extractVersionFromFilename("Checkpoint-Linux-amd64-0.4.11.deb"),
    ).toBe("0.4.11");
    expect(
      extractVersionFromFilename("Checkpoint-Linux-amd64-0.4.11.rpm"),
    ).toBe("0.4.11");
    expect(
      extractVersionFromFilename("Checkpoint-macOS-arm64-0.4.11.pkg"),
    ).toBe("0.4.11");
    expect(extractVersionFromFilename("Checkpoint-macOS-x64-0.4.11.pkg")).toBe(
      "0.4.11",
    );
  });

  it("keeps the whole prerelease suffix without swallowing -Setup", () => {
    expect(
      extractVersionFromFilename(
        "Checkpoint-Windows-x64-0.4.16-nightly.202609030800.g1a2b3c4d-Setup.exe",
      ),
    ).toBe("0.4.16-nightly.202609030800.g1a2b3c4d");
    expect(
      extractVersionFromFilename(
        "Checkpoint-Linux-amd64-0.4.16-nightly.202609030800.g1a2b3c4d.deb",
      ),
    ).toBe("0.4.16-nightly.202609030800.g1a2b3c4d");
  });

  it("ignores files that are not installers", () => {
    // cleanupOldInstallers() deletes by this result, so anything unrecognized
    // has to come back null rather than a guess.
    expect(extractVersionFromFilename("checkpoint-nightly.json")).toBeNull();
    expect(
      extractVersionFromFilename("checkpoint-cli-linux-x64.tar.gz"),
    ).toBeNull();
    expect(extractVersionFromFilename("notes-0.4.11.txt")).toBeNull();
  });
});

/**
 * The daemon exits as part of applying an update, taking its in-memory
 * "installer is downloaded" state with it. Re-adopting the file on startup is
 * what turns a failed install into a one-click retry instead of another 180 MB
 * download, so this has to pick exactly the right file out of the directory.
 */
describe("pickPendingInstaller", () => {
  it("adopts an installer newer than the running version", () => {
    expect(
      pickPendingInstaller(
        ["Checkpoint-Windows-x64-0.4.16-Setup.exe"],
        "0.4.15",
        WINDOWS_PATTERN,
      ),
    ).toEqual({
      name: "Checkpoint-Windows-x64-0.4.16-Setup.exe",
      version: "0.4.16",
    });
  });

  it("ignores installers at or below the running version", () => {
    expect(
      pickPendingInstaller(
        [
          "Checkpoint-Windows-x64-0.4.15-Setup.exe",
          "Checkpoint-Windows-x64-0.4.14-Setup.exe",
        ],
        "0.4.15",
        WINDOWS_PATTERN,
      ),
    ).toBeNull();
  });

  it("picks the newest when several are left behind", () => {
    expect(
      pickPendingInstaller(
        [
          "Checkpoint-Windows-x64-0.4.16-Setup.exe",
          "Checkpoint-Windows-x64-0.5.0-Setup.exe",
          "Checkpoint-Windows-x64-0.4.17-Setup.exe",
        ],
        "0.4.15",
        WINDOWS_PATTERN,
      )?.version,
    ).toBe("0.5.0");
  });

  it("orders nightlies by their prerelease suffix", () => {
    expect(
      pickPendingInstaller(
        [
          "Checkpoint-Windows-x64-0.4.16-nightly.202609070605.g1cc8504e-Setup.exe",
          "Checkpoint-Windows-x64-0.4.16-nightly.202609072126.gcba0da20-Setup.exe",
        ],
        "0.4.16-nightly.202609070605.g1cc8504e",
        WINDOWS_PATTERN,
      )?.version,
    ).toBe("0.4.16-nightly.202609072126.gcba0da20");
  });

  it("skips other platforms' assets and the install marker", () => {
    expect(
      pickPendingInstaller(
        [
          ".installing",
          "Checkpoint-Linux-amd64-0.9.0.deb",
          "Checkpoint-macOS-arm64-0.9.0.pkg",
        ],
        "0.4.15",
        WINDOWS_PATTERN,
      ),
    ).toBeNull();
  });
});
