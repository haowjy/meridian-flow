import { describe, expect, it } from "vitest";

import {
  collisionLabel,
  githubSourceFromUrl,
  partitionUpdateCheck,
  previewWillInstallAgents,
  previewWillInstallSkills,
  updateItemDisplayName,
} from "./package-install-helpers";

describe("package-install-helpers", () => {
  it("normalizes bare GitHub host paths to https URLs", () => {
    expect(githubSourceFromUrl("github.com/lab/pkg")).toEqual({
      kind: "github",
      url: "https://github.com/lab/pkg",
    });
  });

  it("lists preview agents and skills by display name", () => {
    const preview = {
      packageName: "volumetry",
      version: "1.0.0",
      description: null,
      agents: [{ slug: "seg", name: "Segmentation Agent", description: "" }],
      skills: [{ slug: "segment", name: "segment", description: "" }],
      collisions: [],
      includesSetupInstructions: false,
      skippedPackages: [],
    };
    expect(previewWillInstallAgents(preview)).toEqual(["Segmentation Agent"]);
    expect(previewWillInstallSkills(preview)).toEqual(["segment"]);
  });

  it("frames collisions with slug and kind for warning copy", () => {
    expect(collisionLabel({ slug: "measure", kind: "skill", action: "keep_existing" })).toBe(
      'skill "measure"',
    );
  });

  it("partitions update check into will-update and will-keep lists", () => {
    const check = {
      installId: "inst-1",
      packageName: "pkg",
      currentVersion: "1.0.0",
      upstreamVersion: "1.1.0",
      upstreamCommitSha: "abc",
      willUpdate: [{ slug: "segment", kind: "skill" as const }],
      willKeep: [{ slug: "compare", kind: "skill" as const }],
      willRemove: [],
      willRetire: [],
      updateAvailable: true,
    };
    const { willUpdate, willKeep } = partitionUpdateCheck(check);
    expect(willUpdate).toHaveLength(1);
    expect(willKeep).toHaveLength(1);
    const names = new Map([["segment", "Segment skill"]]);
    const updateItem = willUpdate[0];
    const keepItem = willKeep[0];
    expect(updateItem).toBeDefined();
    expect(keepItem).toBeDefined();
    if (!updateItem || !keepItem) return;
    expect(updateItemDisplayName(updateItem, names)).toBe("Segment skill");
    expect(updateItemDisplayName(keepItem, names)).toBe("compare");
  });
});
