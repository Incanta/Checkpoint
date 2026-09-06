/**
 * Version handling in the daemon auto-updater.
 *
 * These two helpers decide whether a machine ever sees a new build, and they
 * fail silently when wrong: a bad comparison just reports "up to date" forever.
 * The nightly channel makes that sharper, because every nightly version is a
 * semver prerelease ("0.5.0-nightly.202609030800.g1a2b3c4d") and the previous
 * numeric-only comparison parsed those as NaN.
 */
import { describe, expect, it } from "vitest";

import {
  compareVersions,
  extractVersionFromFilename,
} from "../../../core/daemon/src/updater.js";

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
    expect(extractVersionFromFilename("Checkpoint-Linux-amd64-0.4.11.deb")).toBe(
      "0.4.11",
    );
    expect(extractVersionFromFilename("Checkpoint-Linux-amd64-0.4.11.rpm")).toBe(
      "0.4.11",
    );
    expect(extractVersionFromFilename("Checkpoint-macOS-arm64-0.4.11.pkg")).toBe(
      "0.4.11",
    );
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
