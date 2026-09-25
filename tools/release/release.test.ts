import { describe, expect, it } from "vitest";
import {
  hasReleaseSkipTrailer,
  nextVersion,
  promoteChangelog,
  resolveBatchIntent,
  resolveIntent,
  unreleasedFirstParentCommits,
} from "./release.mjs";

describe("release intent", () => {
  it.each([
    [[], { release: true, kind: "rc", bump: "patch" }],
    [["release:patch"], { release: true, kind: "stable", bump: "patch" }],
    [["release:stable"], { release: true, kind: "stable", bump: "patch" }],
    [["release:minor"], { release: true, kind: "stable", bump: "minor" }],
    [["release:major"], { release: true, kind: "stable", bump: "major" }],
    [["release:rc"], { release: true, kind: "rc", bump: "patch" }],
    [["release:wat"], { release: true, kind: "rc", bump: "patch" }],
    [["release:patch", "release:skip"], { release: false, kind: "skip" }],
  ])("%j resolves to %j", (labels, expected) => expect(resolveIntent(labels)).toEqual(expected));
});

describe("exact release skip", () => {
  it("recognizes only the exact trailing Release-Skip trailer", () => {
    expect(hasReleaseSkipTrailer("merge body mentions release:skip as text")).toBe(false);
    expect(hasReleaseSkipTrailer("Release-Skip: true is ordinary body text")).toBe(false);
    expect(hasReleaseSkipTrailer("Merge title\n\nRelease-Skip: true")).toBe(true);
  });
});

describe("main release coverage", () => {
  it("covers first-parent commits after the latest release boundary", () => {
    expect(
      unreleasedFirstParentCommits([
        { sha: "merge-1", isRelease: false },
        { sha: "release-1", isRelease: true },
        { sha: "merge-2", isRelease: false },
        { sha: "merge-3", isRelease: false },
      ]),
    ).toEqual(["merge-2", "merge-3"]);
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

  it("skips only excluded merges and does not let skip labels suppress the batch", () => {
    expect(
      resolveBatchIntent([
        { sha: "skip-label", labels: ["release:skip", "release:major"] },
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

  it("does not release when every uncovered merge is skipped", () => {
    expect(
      resolveBatchIntent([
        { sha: "skip-label", labels: ["release:skip"] },
        { sha: "skip-trailer", labels: [], skipTrailer: true },
      ]),
    ).toEqual({
      release: false,
      kind: "skip",
      covered: [],
      skipped: ["skip-label", "skip-trailer"],
    });
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
