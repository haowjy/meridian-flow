import { encodeNavigationPosition, getBlockItemId } from "@meridian/agent-edit";
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
    pushId: null,
    receiptId: null,
    kind: "delete",
    beforeBlockId: null,
    afterBlockId: null,
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

function registryFor(doc: Y.Doc, status: "synced" | "syncing", markerIds: readonly string[] = []) {
  const events: string[] = [];
  return {
    events,
    registry: {
      retain: () => events.push("retain"),
      release: () => events.push("release"),
      get: () => ({
        document: doc,
        markerStore: {
          getSnapshot: () => markerIds.map((changeId) => ({ changeId, dismissed: false })),
        },
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
    const showRange = vi.fn(() => ({ shown: true }));
    await expect(
      navigateToTrailChange({
        documentId: "doc-1",
        change: deletionChange(doc),
        openDocument: async () => true,
        registry: registry as never,
        showRange,
      }),
    ).resolves.toEqual({ kind: "shown" });
    expect(events).toEqual(["retain", "sync", "release"]);
    expect(showRange).toHaveBeenCalledOnce();
  });

  it("reveals an existing session mark instead of adding a generic range", async () => {
    const doc = new Y.Doc({ gc: false });
    const { registry } = registryFor(doc, "synced", ["change-1"]);
    const showMarker = vi.fn(() => ({ shown: true }));
    const showRange = vi.fn(() => ({ shown: true }));

    await expect(
      navigateToTrailChange({
        documentId: "doc-1",
        change: deletionChange(doc),
        openDocument: async () => true,
        registry: registry as never,
        showMarker,
        showRange,
      }),
    ).resolves.toEqual({ kind: "shown" });
    expect(showMarker).toHaveBeenCalledWith("doc-1", "change-1");
    expect(showRange).not.toHaveBeenCalled();
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
        targetBlockId: { ...getBlockItemId(root.get(0) as Y.XmlElement), clock: 999 },
      },
    };
    const { registry } = registryFor(doc, "synced");
    const showRange = vi.fn(() => ({ shown: true }));
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

  it("revalidates after a concurrent delete between validation and show", async () => {
    const doc = new Y.Doc({ gc: false });
    const root = doc.getXmlFragment("prosemirror");
    const block = new Y.XmlElement("paragraph");
    root.insert(0, [block]);
    const change: TrailChange = {
      ...deletionChange(doc),
      kind: "modify",
      navigation: {
        kind: "live_block_range",
        relStart: encodeNavigationPosition(Y.createRelativePositionFromTypeIndex(root, 0)),
        relEnd: encodeNavigationPosition(Y.createRelativePositionFromTypeIndex(root, 1)),
        targetBlockId: getBlockItemId(block),
      },
    };
    const { registry } = registryFor(doc, "synced");
    const showRange = vi.fn(() => {
      root.delete(0, 1);
      return { shown: false };
    });

    await expect(
      navigateToTrailChange({
        documentId: "doc-1",
        change,
        openDocument: async () => true,
        registry: registry as never,
        showRange,
        timeoutMs: 100,
      }),
    ).resolves.toEqual({ kind: "unavailable" });
    expect(showRange).toHaveBeenCalledOnce();
  });

  it("cancellation releases retention and prevents a later highlight", async () => {
    const doc = new Y.Doc({ gc: false });
    const { registry, events } = registryFor(doc, "synced");
    const controller = new AbortController();
    const showRange = vi.fn(() => {
      controller.abort();
      return { shown: true };
    });

    await expect(
      navigateToTrailChange({
        documentId: "doc-1",
        change: deletionChange(doc),
        openDocument: async () => true,
        registry: registry as never,
        showRange,
        signal: controller.signal,
      }),
    ).resolves.toEqual({ kind: "could_not_open" });
    expect(events).toEqual(["retain", "sync", "release"]);
  });

  it("releases retention immediately when cancelled during sync", async () => {
    const doc = new Y.Doc({ gc: false });
    const events: string[] = [];
    const controller = new AbortController();
    const navigation = navigateToTrailChange({
      documentId: "doc-1",
      change: deletionChange(doc),
      openDocument: async () => true,
      registry: {
        retain: () => events.push("retain"),
        release: () => events.push("release"),
        get: () => ({
          document: doc,
          waitForCurrentSync: () => new Promise<void>(() => undefined),
          getSnapshot: () => ({ status: "syncing" }),
        }),
      } as never,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(events).toEqual(["retain"]));
    controller.abort();
    await expect(navigation).resolves.toEqual({ kind: "could_not_open" });
    expect(events).toEqual(["retain", "release"]);
  });
});
