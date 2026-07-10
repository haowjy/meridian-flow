import { encodeNavigationPosition } from "@meridian/agent-edit";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { TrailChange } from "@/client/change-trails";
import { navigateToTrailChange } from "./change-trail-navigation";

function deletionChange(doc: Y.Doc): TrailChange {
  const root = doc.getXmlFragment("prosemirror");
  return {
    changeId: "change-1",
    ordinal: 1,
    documentId: "doc-1",
    kind: "delete",
    beforeText: "gone",
    afterTextAtReceipt: null,
    navigation: {
      kind: "deletion_boundary",
      position: encodeNavigationPosition(Y.createRelativePositionFromTypeIndex(root, 0)),
      affinity: "document_start",
    },
    swept: null,
    reversible: false,
  };
}

function registryFor(doc: Y.Doc, status: "synced" | "syncing") {
  const events: string[] = [];
  return {
    events,
    registry: {
      retain: () => events.push("retain"),
      release: () => events.push("release"),
      get: () => ({
        document: doc,
        waitForCurrentSync: async () => events.push("sync"),
        getSnapshot: () => ({ status }),
      }),
    },
  };
}

describe("change trail navigation", () => {
  it("retains the session through sync and releases after editor handoff", async () => {
    const doc = new Y.Doc({ gc: false });
    const { registry, events } = registryFor(doc, "synced");
    const showRange = vi.fn(() => ({ shown: true, currentText: null }));
    await expect(
      navigateToTrailChange({
        documentId: "doc-1",
        change: deletionChange(doc),
        openDocument: async () => true,
        registry: registry as never,
        showRange,
      }),
    ).resolves.toEqual({ kind: "shown", currentText: null });
    expect(events).toEqual(["retain", "sync", "release"]);
    expect(showRange).toHaveBeenCalledOnce();
  });

  it("reports a sync timeout honestly and still releases", async () => {
    const doc = new Y.Doc({ gc: false });
    const { registry, events } = registryFor(doc, "syncing");
    await expect(
      navigateToTrailChange({
        documentId: "doc-1",
        change: deletionChange(doc),
        openDocument: async () => true,
        registry: registry as never,
      }),
    ).resolves.toEqual({ kind: "could_not_open" });
    expect(events).toEqual(["retain", "sync", "release"]);
  });

  it("does not scroll when a live block identity no longer matches", async () => {
    const doc = new Y.Doc({ gc: false });
    const root = doc.getXmlFragment("prosemirror");
    root.insert(0, [new Y.XmlElement("paragraph")]);
    const change = {
      ...deletionChange(doc),
      kind: "modify" as const,
      navigation: {
        kind: "live_block_range" as const,
        relStart: encodeNavigationPosition(Y.createRelativePositionFromTypeIndex(root, 0)),
        relEnd: encodeNavigationPosition(Y.createRelativePositionFromTypeIndex(root, 1)),
        targetBlockId: "wrong",
      },
    };
    const { registry } = registryFor(doc, "synced");
    const showRange = vi.fn(() => ({ shown: true, currentText: "wrong" }));
    await expect(
      navigateToTrailChange({
        documentId: "doc-1",
        change,
        openDocument: async () => true,
        registry: registry as never,
        showRange,
      }),
    ).resolves.toEqual({ kind: "unavailable" });
    expect(showRange).not.toHaveBeenCalled();
  });
});
