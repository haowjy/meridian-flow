/** Tests for mars-agents compatible version constraint parsing. */
import { describe, expect, it } from "vitest";

import {
  parseMarsVersionConstraint,
  parseSemverTags,
  selectNewestSatisfyingTag,
} from "./mars-version-constraint.js";

describe("parseMarsVersionConstraint", () => {
  it.each([
    [undefined, { kind: "latest", raw: null }],
    ["", { kind: "latest", raw: "" }],
    ["latest", { kind: "latest", raw: "latest" }],
    ["v1.2.3", { kind: "version", raw: "v1.2.3", range: "=1.2.3" }],
    ["1.2.3", { kind: "version", raw: "1.2.3", range: "=1.2.3" }],
    ["v2", { kind: "version", raw: "v2", range: ">=2.0.0 <3.0.0" }],
    ["v2.1", { kind: "version", raw: "v2.1", range: ">=2.1.0 <2.2.0" }],
    [">=0.5.0", { kind: "version", raw: ">=0.5.0", range: ">=0.5.0" }],
    ["^2.0", { kind: "version", raw: "^2.0", range: ">=2.0.0 <3.0.0-0" }],
    ["~1.2", { kind: "version", raw: "~1.2", range: ">=1.2.0 <1.3.0-0" }],
    [">=0.7.0, <0.8.0", { kind: "version", raw: ">=0.7.0, <0.8.0" }],
    ["main", { kind: "ref", raw: "main", ref: "main" }],
    ["deadbeef", { kind: "ref", raw: "deadbeef", ref: "deadbeef" }],
  ])("parses %s", (input, expected) => {
    expect(parseMarsVersionConstraint(input)).toMatchObject(expected);
  });
});

describe("parseSemverTags", () => {
  it("accepts version tags while silently skipping non-version tags", () => {
    expect(parseSemverTags(["release-candidate", "v0.7.2", "0.7.1", "main"])).toEqual([
      { tag: "0.7.1", version: "0.7.1" },
      { tag: "v0.7.2", version: "0.7.2" },
    ]);
  });

  it("selects the newest satisfying tag", () => {
    const tags = parseSemverTags(["v0.7.0", "v0.7.3", "v0.8.0"]);
    expect(selectNewestSatisfyingTag(tags, parseMarsVersionConstraint(">=0.7.0, <0.8.0"))).toEqual({
      tag: "v0.7.3",
      version: "0.7.3",
    });
  });

  it("lets latest resolve prerelease-only repositories", () => {
    const tags = parseSemverTags(["v1.0.0-alpha.1", "v1.0.0-rc.1"]);
    expect(selectNewestSatisfyingTag(tags, parseMarsVersionConstraint("latest"))).toEqual({
      tag: "v1.0.0-rc.1",
      version: "1.0.0-rc.1",
    });
  });

  it("selects a prerelease when it is the only satisfying version in a range", () => {
    const tags = parseSemverTags(["v1.9.0", "v2.5.0-rc", "v3.0.0"]);
    expect(selectNewestSatisfyingTag(tags, parseMarsVersionConstraint(">=2.0.0 <3.0.0"))).toEqual({
      tag: "v2.5.0-rc",
      version: "2.5.0-rc",
    });
  });

  it("matches exact prerelease pins", () => {
    const tags = parseSemverTags(["v2.1.0-rc1", "v2.1.0-beta1"]);
    expect(selectNewestSatisfyingTag(tags, parseMarsVersionConstraint("v2.1.0-rc1"))).toEqual({
      tag: "v2.1.0-rc1",
      version: "2.1.0-rc1",
    });
  });

  it("keeps version ordering when stable and prerelease tags both satisfy", () => {
    const tags = parseSemverTags(["v1.2.0-rc.1", "v1.2.0", "v1.1.0"]);
    expect(selectNewestSatisfyingTag(tags, parseMarsVersionConstraint(">=1.0.0 <2.0.0"))).toEqual({
      tag: "v1.2.0",
      version: "1.2.0",
    });
  });
});
