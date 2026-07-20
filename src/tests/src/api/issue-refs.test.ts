// Unit tests for the shared "#<native-id>" issue reference utilities
// (tokenizer + URL template builders) in @checkpointvcs/common. The app
// keeps a mirror at src/app/src/lib/issue-refs.ts; these tests cover the
// canonical copy.

import { describe, it, expect } from "vitest";
import {
  tokenizeIssueRefs,
  buildIssueUrlTemplate,
  fillIssueUrl,
  getIssueRefPattern,
} from "@checkpointvcs/common";

describe("tokenizeIssueRefs", () => {
  it("linkifies numeric refs on CHECKPOINT", () => {
    expect(tokenizeIssueRefs("Fixes #123 now", "CHECKPOINT")).toEqual([
      { type: "text", text: "Fixes " },
      { type: "ref", text: "#123", refId: "123" },
      { type: "text", text: " now" },
    ]);
  });

  it("matches a ref at the start of the string", () => {
    expect(tokenizeIssueRefs("#7 fixed", "HACKNPLAN")).toEqual([
      { type: "ref", text: "#7", refId: "7" },
      { type: "text", text: " fixed" },
    ]);
  });

  it("finds multiple refs in one string", () => {
    const segments = tokenizeIssueRefs("Fix #1 and #2", "CHECKPOINT");
    expect(segments.filter((s) => s.type === "ref").map((s) => s.refId))
      .toEqual(["1", "2"]);
  });

  it("does not match ##123, mid-word refs, or markdown headings", () => {
    for (const text of ["##123", "a#123", "# 123", "#123abc"]) {
      const segments = tokenizeIssueRefs(text, "CHECKPOINT");
      expect(segments).toEqual([{ type: "text", text }]);
    }
  });

  it("matches Jira keys only on JIRA", () => {
    expect(tokenizeIssueRefs("See #PROJ-123.", "JIRA")).toEqual([
      { type: "text", text: "See " },
      { type: "ref", text: "#PROJ-123", refId: "PROJ-123" },
      { type: "text", text: "." },
    ]);
    // Numeric refs are not Jira keys
    expect(tokenizeIssueRefs("See #123.", "JIRA")).toEqual([
      { type: "text", text: "See #123." },
    ]);
    // Lowercase keys don't match
    expect(tokenizeIssueRefs("see #proj-123", "JIRA")).toEqual([
      { type: "text", text: "see #proj-123" },
    ]);
  });

  it("matches short card ids on CODECKS, with optional $", () => {
    expect(
      tokenizeIssueRefs("card #1a7 done", "CODECKS").find(
        (s) => s.type === "ref",
      )?.refId,
    ).toBe("1a7");
    expect(
      tokenizeIssueRefs("card #$1a7 done", "CODECKS").find(
        (s) => s.type === "ref",
      )?.refId,
    ).toBe("$1a7");
  });

  it("never matches on DISABLED", () => {
    expect(getIssueRefPattern("DISABLED")).toBeNull();
    expect(tokenizeIssueRefs("Fixes #123", "DISABLED")).toEqual([
      { type: "text", text: "Fixes #123" },
    ]);
  });

  it("returns an empty array for empty text", () => {
    expect(tokenizeIssueRefs("", "CHECKPOINT")).toEqual([]);
  });
});

describe("buildIssueUrlTemplate / fillIssueUrl", () => {
  it("builds Jira browse URLs, stripping trailing slashes", () => {
    const template = buildIssueUrlTemplate("JIRA", {
      jiraBaseUrl: "https://acme.atlassian.net/",
    });
    expect(template).toBe("https://acme.atlassian.net/browse/{id}");
    expect(fillIssueUrl(template!, "PROJ-123")).toBe(
      "https://acme.atlassian.net/browse/PROJ-123",
    );
  });

  it("builds HacknPlan board URLs from the project id", () => {
    const template = buildIssueUrlTemplate("HACKNPLAN", {
      hacknplanProjectId: 42,
    });
    expect(template).toBe("https://app.hacknplan.com/p/42/kanban?taskId={id}");
    expect(fillIssueUrl(template!, "7")).toBe(
      "https://app.hacknplan.com/p/42/kanban?taskId=7",
    );
  });

  it("builds Codecks card URLs from the subdomain", () => {
    const template = buildIssueUrlTemplate("CODECKS", {
      codecksSubdomain: "acme",
    });
    expect(template).toBe("https://acme.codecks.io/card/{id}");
  });

  it("returns null for CHECKPOINT/DISABLED and missing config", () => {
    expect(buildIssueUrlTemplate("CHECKPOINT", {})).toBeNull();
    expect(buildIssueUrlTemplate("DISABLED", {})).toBeNull();
    expect(buildIssueUrlTemplate("JIRA", {})).toBeNull();
    expect(buildIssueUrlTemplate("CODECKS", {})).toBeNull();
    expect(buildIssueUrlTemplate("HACKNPLAN", {})).toBeNull();
  });

  it("URI-encodes the id when filling", () => {
    expect(fillIssueUrl("https://x.codecks.io/card/{id}", "$1a7")).toBe(
      "https://x.codecks.io/card/%241a7",
    );
  });
});
