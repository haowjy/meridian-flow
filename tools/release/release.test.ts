import { describe, expect, it } from "vitest";
import {
  classifyPushFailure,
  nextVersion,
  promoteChangelog,
  resolveBatch,
  resolveBatchIntent,
  resolveIntent,
  selectPullRequest,
  uncoveredCommits,
} from "./release.ts";

describe("release intent", () => {
  it.each([
    [[], { release: true, kind: "rc", bump: "patch" }],
    [["release:patch"], { release: true, kind: "stable", bump: "patch" }],
    [["release:stable"], { release: true, kind: "rc", bump: "patch" }],
    [["release:minor"], { release: true, kind: "stable", bump: "minor" }],
    [["release:major"], { release: true, kind: "stable", bump: "major" }],
    [["release:rc"], { release: true, kind: "rc", bump: "patch" }],
    [["release:wat"], { release: true, kind: "rc", bump: "patch" }],
    [["release:patch", "release:skip"], { release: false, kind: "skip" }],
  ])("%j resolves to %j", (labels, expected) => expect(resolveIntent(labels)).toEqual(expected));
});

describe("main release coverage", () => {
  const merge = (sha: string) => ({ sha, subject: `Merge ${sha}`, tags: [] });

  it("starts after the latest release boundary and uses the workflow bootstrap when tagless", () => {
    expect(
      uncoveredCommits(
        [merge("old"), { sha: "release", subject: "release: v1.2.3", tags: [] }, merge("new")],
        null,
      ),
    ).toEqual(["new"]);
    expect(uncoveredCommits([merge("old"), merge("workflow"), merge("new")], "workflow")).toEqual([
      "new",
    ]);
    expect(() => uncoveredCommits([merge("old")], null)).toThrow("No release boundary");
  });

  it("prefers an exact PR and identifies a rebase-merge fallback", () => {
    const exact = {
      number: 1,
      merged_at: "now",
      base: { ref: "main" },
      merge_commit_sha: "sha",
      labels: [],
    };
    const other = { ...exact, number: 2, merge_commit_sha: "other" };
    expect(selectPullRequest("sha", [other, exact])).toMatchObject({
      pullRequest: exact,
      reason: "exact merge SHA",
      rebaseMerge: false,
    });
    expect(selectPullRequest("rebased", [other])).toMatchObject({
      pullRequest: other,
      reason: "merged PR fallback",
      rebaseMerge: true,
    });
    expect(() => selectPullRequest("sha", [])).toThrow("Expected one merged PR");
  });

  it("skips rebase-merge commits while resolving a batch", async () => {
    const history = [
      { sha: "base", subject: "release: v1.0.0", tags: [] },
      merge("rebased"),
      merge("merge"),
    ];
    const messages = new Map([
      ["rebased", "body"],
      ["merge", "body"],
    ]);
    const git = {
      firstParent: () => history,
      workflowIntroduction: () => null,
      message: (sha: string) => messages.get(sha) ?? "",
    };
    const github = {
      pullRequests: (sha: string) => [
        {
          number: 1,
          merged_at: "now",
          base: { ref: "main" },
          merge_commit_sha: sha === "rebased" ? "represented-elsewhere" : sha,
          labels: [{ name: "release:minor" }],
        },
      ],
    };
    await expect(resolveBatch(git as never, github)).resolves.toMatchObject({
      covered: ["merge"],
      kind: "stable",
      bump: "minor",
    });
  });

  it("takes the strongest non-skipped merge intent", () => {
    expect(
      resolveBatchIntent([
        { sha: "rc", labels: [] },
        { sha: "minor", labels: ["release:minor"] },
        { sha: "major", labels: ["release:major"] },
        { sha: "patch", labels: ["release:patch"] },
      ]),
    ).toEqual({
      release: true,
      kind: "stable",
      bump: "major",
      covered: ["rc", "minor", "major", "patch"],
      skipped: [],
    });
  });
  it("skips excluded merges", () => {
    expect(
      resolveBatchIntent([
        { sha: "skip-label", labels: ["release:skip"] },
        { sha: "skip-trailer", labels: [], skipTrailer: true },
        { sha: "minor", labels: ["release:minor"] },
      ]),
    ).toEqual({
      release: true,
      kind: "stable",
      bump: "minor",
      covered: ["minor"],
      skipped: ["skip-label", "skip-trailer"],
    });
  });
});

describe("push failure classification", () => {
  it("distinguishes protection rejection from a concurrent main update", () => {
    expect(classifyPushFailure("remote: GH013 ruleset violation", "parent", "parent")).toBe(
      "protection",
    );
    expect(classifyPushFailure("non-fast-forward", "new-tip", "parent")).toBe("race");
    expect(
      classifyPushFailure(
        "remote: Permission to haowjy/meridian-flow.git denied to github-actions[bot].\nfatal: unable to access: The requested URL returned error: 403",
        "parent",
        "parent",
      ),
    ).toBe("protection");
  });
});

describe("version selection", () => {
  it("bootstraps from 0.0.0 and numbers rc tags despite collisions", () => {
    const rcIntent = resolveIntent([]);
    expect(nextVersion([], rcIntent)).toBe("v0.0.1-rc.1");
    expect(nextVersion(["v0.0.1-rc.1"], rcIntent)).toBe("v0.0.1-rc.2");
    expect(nextVersion(["v0.0.1-rc.1", "v0.0.1-rc.2"], resolveIntent(["release:minor"]))).toBe(
      "v0.1.0",
    );
  });
  it("starts the next rc from the latest stable patch and ignores invalid tags", () => {
    expect(nextVersion(["v0.1.0", "v0.1.1-rc.1", "not-a-version"], resolveIntent([]))).toBe(
      "v0.1.1-rc.2",
    );
  });
});

describe("changelog promotion", () => {
  it("preserves text before Unreleased and all older releases", () => {
    const source =
      "# Changelog\n\n- Entries before section\n\n## [Unreleased]\n\n### Changed\n\n- New item\n\n## [0.0.1] - 2026-01-01\n\n- Old item\n";
    expect(promoteChangelog(source, "0.1.0", "2026-09-24")).toBe(
      "# Changelog\n\n- Entries before section\n\n## [Unreleased]\n\n## [0.1.0] - 2026-09-24\n\n### Changed\n\n- New item\n\n## [0.0.1] - 2026-01-01\n\n- Old item\n",
    );
  });
  it("fails rather than silently changing a malformed changelog", () =>
    expect(() => promoteChangelog("# no section", "0.1.0", "2026-09-24")).toThrow(
      /no ## \[Unreleased\]/,
    ));
});
