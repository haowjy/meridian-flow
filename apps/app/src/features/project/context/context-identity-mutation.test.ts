/** Converged cache and identity outcomes through the untitled lifecycle rig. */

import type { MoveContextEntryResult } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { lifecycleGate, UntitledLifecycleRig } from "./test-support/UntitledLifecycleRig";

const SOURCE = { scheme: "scratch", path: "/Untitled.md", workId: "work-1" } as const;
const OPENING = {
  name: "Opening.md",
  destination: { scheme: "manuscript", folderPath: "/Act 1" },
} as const;

describe("context identity mutation outcomes", () => {
  it("invalidates the durable tree after materialization", async () => {
    const rig = new UntitledLifecycleRig();
    rig.seedTree("project-1", "scratch", "work-1");

    await rig.identityMutations.materialized("project-1", {
      status: "created",
      documentId: "doc-1",
      scheme: "scratch",
      path: "/Untitled",
      name: "Untitled",
      workId: "work-1",
    });

    expect(rig.treeInvalidated("project-1", "scratch", "work-1")).toBe(true);
  });

  it("moves from the canonical source and invalidates both affected trees", async () => {
    const rig = new UntitledLifecycleRig();
    rig.seedTree("project-1", "scratch", "work-1");
    rig.seedTree("project-1", "manuscript");

    await rig.identityMutations.move("doc-1", "project-1", SOURCE, OPENING);

    expect(rig.identityMove.calls).toEqual([
      [
        "project-1",
        "scratch",
        {
          path: "Untitled.md",
          sourceWorkId: "work-1",
          destinationScheme: "manuscript",
          destinationFolderPath: "Act 1",
          newName: "Opening.md",
        },
      ],
    ]);
    expect(rig.treeInvalidated("project-1", "scratch", "work-1")).toBe(true);
    expect(rig.treeInvalidated("project-1", "manuscript")).toBe(true);
  });

  it("serializes overlapping moves and rebases the newest intent on the receipt", async () => {
    const rig = new UntitledLifecycleRig();
    const firstMove = lifecycleGate<MoveContextEntryResult>();
    rig.identityMove.enqueueHandler(() => firstMove.promise);
    rig.identityMove.enqueueResult({
      status: "moved",
      scheme: "manuscript",
      path: "Final/Latest.md",
      name: "Latest.md",
    });

    const background = rig.identityMutations.move("doc-1", "project-1", SOURCE, {
      name: "Background.md",
      destination: { scheme: "manuscript", folderPath: "/Drafts" },
    });
    const foreground = rig.identityMutations.move("doc-1", "project-1", SOURCE, {
      name: "Latest.md",
      destination: { scheme: "manuscript", folderPath: "/Final" },
    });
    await Promise.resolve();
    expect(rig.identityMove.calls).toHaveLength(1);

    firstMove.resolve({
      status: "moved",
      scheme: "manuscript",
      path: "Drafts/Background.md",
      name: "Background.md",
    });

    await expect(background).resolves.toMatchObject({ isLatest: false });
    await expect(foreground).resolves.toMatchObject({ isLatest: true });
    expect(rig.identityMove.calls[1]).toEqual([
      "project-1",
      "manuscript",
      {
        path: "Drafts/Background.md",
        destinationScheme: "manuscript",
        destinationFolderPath: "Final",
        newName: "Latest.md",
      },
    ]);
  });

  it("uses a fresh source after a settled queue", async () => {
    const rig = new UntitledLifecycleRig();
    rig.identityMove.enqueueResult(
      {
        status: "moved",
        scheme: "manuscript",
        path: "Drafts/First.md",
        name: "First.md",
      },
      {
        status: "moved",
        scheme: "manuscript",
        path: "Final/Latest.md",
        name: "Latest.md",
      },
    );

    await rig.identityMutations.move("doc-1", "project-1", SOURCE, {
      name: "First.md",
      destination: { scheme: "manuscript", folderPath: "/Drafts" },
    });
    await rig.identityMutations.move(
      "doc-1",
      "project-1",
      { scheme: "manuscript", path: "/External/Elsewhere.md" },
      { name: "Latest.md", destination: { scheme: "manuscript", folderPath: "/Final" } },
    );

    expect(rig.identityMove.calls[1]?.[2]).toMatchObject({ path: "External/Elsewhere.md" });
  });

  it("drops a queued canonical source after a stale outcome", async () => {
    const rig = new UntitledLifecycleRig();
    const firstMove = lifecycleGate<MoveContextEntryResult>();
    rig.identityMove.enqueueHandler(() => firstMove.promise);
    rig.identityMove.enqueueResult(
      { status: "retry", reason: "stale-source" },
      {
        status: "moved",
        scheme: "manuscript",
        path: "Final/Latest.md",
        name: "Latest.md",
      },
    );

    const first = rig.identityMutations.move("doc-1", "project-1", SOURCE, {
      name: "First.md",
      destination: { scheme: "manuscript", folderPath: "/Drafts" },
    });
    const stale = rig.identityMutations.move("doc-1", "project-1", SOURCE, {
      name: "Stale.md",
      destination: { scheme: "manuscript", folderPath: "/Stale" },
    });
    const fresh = rig.identityMutations.move(
      "doc-1",
      "project-1",
      { scheme: "manuscript", path: "/External/Elsewhere.md" },
      { name: "Latest.md", destination: { scheme: "manuscript", folderPath: "/Final" } },
    );
    await Promise.resolve();
    firstMove.resolve({
      status: "moved",
      scheme: "manuscript",
      path: "Drafts/First.md",
      name: "First.md",
    });
    await Promise.all([first, stale, fresh]);

    expect(rig.identityMove.calls[2]?.[2]).toMatchObject({ path: "External/Elsewhere.md" });
  });
});
