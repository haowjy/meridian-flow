import type { ChangeEventWsMessage } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  SESSION_MARKER_CAP,
  SESSION_MARKER_RESOLUTION_WINDOW_MS,
  SessionMarkerStore,
} from "./session-marker-store";

function encodedPosition(): string {
  const doc = new Y.Doc();
  const position = Y.createRelativePositionFromTypeIndex(doc.getXmlFragment("prosemirror"), 0);
  const bytes = Y.encodeRelativePosition(position);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function message(
  revision: number,
  changes: Array<{ id: string; swept?: boolean }> = [{ id: "change-1" }],
  overrides: Partial<ChangeEventWsMessage> = {},
): ChangeEventWsMessage {
  const position = encodedPosition();
  return {
    type: "change_event",
    documentId: "doc-1",
    threadId: "thread-1",
    trailId: "trail-1",
    projectionRevision: revision,
    author: { kind: "agent", threadId: "thread-1", turnId: "turn-1" },
    admittedByUserId: null,
    changes: changes.map(({ id, swept }) => ({
      changeId: id,
      kind: "modify",
      navigation: {
        kind: "live_block_range",
        relStart: position,
        relEnd: position,
        targetBlockId: { clientID: 1, clock: 0 },
      },
      swept: swept ?? false,
      excerpt: id,
      pureDeletionOffset: null,
    })),
    truncated: false,
    ...overrides,
  };
}

describe("SessionMarkerStore", () => {
  it("replaces a group, rejects stale revisions, and carries dismissal by surviving id", () => {
    const store = new SessionMarkerStore("me");
    store.replaceGroup(message(2, [{ id: "keep" }, { id: "gone" }]));
    store.dismiss("keep");
    store.replaceGroup(message(1, [{ id: "stale" }]));
    expect(store.getSnapshot().map((marker) => marker.changeId)).toEqual(["keep", "gone"]);

    store.replaceGroup(message(3, [{ id: "keep" }, { id: "new" }]));
    expect(store.getSnapshot().map(({ changeId, dismissed }) => [changeId, dismissed])).toEqual([
      ["keep", true],
      ["new", false],
    ]);
  });

  it("suppresses a change admitted by the current writer", () => {
    const store = new SessionMarkerStore("me");
    store.replaceGroup(message(1, undefined, { admittedByUserId: "me" }));
    expect(store.getSnapshot()).toHaveLength(0);
  });

  it("caps the session by evicting oldest non-swept markers before swept markers", () => {
    let now = 0;
    const store = new SessionMarkerStore("me", () => now++);
    store.replaceGroup(message(1, [{ id: "old-swept", swept: true }]));
    for (let index = 0; index < SESSION_MARKER_CAP; index++) {
      store.replaceGroup(
        message(1, [{ id: `plain-${index}` }], {
          trailId: `trail-${index + 2}`,
        }),
      );
    }
    expect(store.getSnapshot()).toHaveLength(SESSION_MARKER_CAP);
    expect(store.getSnapshot().some((marker) => marker.changeId === "old-swept")).toBe(true);
    expect(store.getSnapshot().some((marker) => marker.changeId === "plain-0")).toBe(false);
  });

  it("retries unresolved anchors and evicts them after the reorder window", () => {
    let now = 10;
    const store = new SessionMarkerStore("me", () => now);
    store.replaceGroup(message(1));
    store.reconcileAnchors(() => false);
    expect(store.getSnapshot()[0]?.anchor.type).toBe("unresolved");
    store.reconcileAnchors(() => true);
    expect(store.getSnapshot()[0]?.anchor.type).toBe("range");

    store.replaceGroup(message(1, undefined, { trailId: "trail-2" }));
    now += SESSION_MARKER_RESOLUTION_WINDOW_MS + 1;
    store.reconcileAnchors(() => false);
    expect(store.getSnapshot()).toHaveLength(0);
  });
});
