// @vitest-environment node
/**
 * The expanded-row Discard on real hooks over the real branch-room pool. It protects: a rendered, enabled
 * row whose Discard has nothing to write into (readiness before the room is held), and an Undo that
 * outlives its room (the reader let go on collapse while the Discard entry stayed).
 */

import { branchRoomName } from "@meridian/contracts/protocol";
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useState } from "react";
import { expect, it, vi } from "vitest";
import * as Y from "yjs";
import { draftAttributionQueryOptions } from "@/client/query/useDraftAttribution";
import { draftMetaQueryOptions } from "@/client/query/useDraftMeta";
import { BranchRoomPool } from "@/core/editor/branch-room-pool";
import { DocumentSessionTeardownOwner } from "@/core/editor/document-session-teardown-owner";
import { seedReviewBase } from "@/test-support/inline-review-editor";
import { settleReact, withReactRoot } from "@/test-support/react-dom-harness";
import { retainReviewRuntime, reviewRuntimeOf } from "./review-runtime";
import { useDraftView } from "./useDraftView";
import { useHeadlessDiscards } from "./useHeadlessDiscards";

// One port object for the test's life, as the account's registry is: a new one per render would re-run effects.
const registry = vi.hoisted(() => ({ port: {} as Record<string, unknown> }));
vi.mock("@/features/project/context/account-feature-context", () => ({
  useLiveDocumentSessionRegistry: () => registry.port,
}));

const ROOM = branchRoomName("draft");
const draft = { projectId: "p", workId: "w", documentId: "doc", itemKey: "draft:doc" };
const file = { documentId: "doc", draft: { itemKey: "draft:doc" } } as never;
const text = (doc: Y.Doc) =>
  (doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).get(0) as Y.XmlElement).toString();

function fixture() {
  const doc = new Y.Doc({ gc: false });
  const paragraph = new Y.XmlElement("paragraph");
  const run = new Y.XmlText();
  paragraph.insert(0, [run]);
  run.insert(0, "green");
  doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).insert(0, [paragraph]);
  seedReviewBase(doc, ["red"]);
  const room = {
    document: doc,
    getSnapshot: () => ({ status: "synced" }) as never,
    subscribe: () => () => {},
    whenSynced: () => Promise.resolve(),
    hasUnacknowledgedEdits: () => false,
    destroy: vi.fn(async () => {}),
  };
  // The real pool: a room lives while any owner retains it and is destroyed after the grace once none does.
  const pool = new BranchRoomPool({
    teardownGraceMs: 1,
    teardownOwner: new DocumentSessionTeardownOwner(() => new Error("unavailable")),
    openSession: () => room as never,
  });
  registry.port = {
    retainBranchRooms: (owner: string, rooms: readonly string[]) => pool.retain(owner, rooms),
    releaseBranchRooms: (owner: string) => pool.release(owner),
    getBranchRoom: (roomKey: string) => pool.get(roomKey),
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(draftMetaQueryOptions(draft).queryKey, {
    kind: "text",
    draftId: "draft",
    itemKey: "draft:doc",
    documentId: "doc",
    roomName: ROOM,
    isNew: false,
    wholeItem: false,
    hasChanges: true,
  });
  client.setQueryData(draftAttributionQueryOptions(draft).queryKey, {
    itemKey: "draft:doc",
    userId: "user-1",
    edits: [],
  });
  return { doc, room, client, pool };
}

it("a row another surface's runtime made ready is actionable only once its room is held; collapse keeps the room for Undo, and the last release disposes it", async () => {
  const { doc, room, client, pool } = fixture();
  const release = retainReviewRuntime(draft, room as never, client);
  reviewRuntimeOf(draft)?.projectNow();
  const renders: { rows: number; ready: boolean }[] = [];
  let discards!: ReturnType<typeof useHeadlessDiscards>;
  let view!: ReturnType<typeof useDraftView>;
  function Probe({ enabled }: { enabled: boolean }) {
    discards = useHeadlessDiscards("p", "w");
    view = useDraftView(draft, {
      controller: { changesLocked: false } as never,
      enabled,
      file,
      discards,
    });
    renders.push({ rows: view.items.length, ready: view.status === "ready" });
    return null;
  }
  let collapse!: () => void;
  function Reader() {
    const [enabled, setEnabled] = useState(true);
    collapse = () => setEnabled(false);
    return <Probe enabled={enabled} />;
  }
  const node = (
    <QueryClientProvider client={client}>
      <Reader />
    </QueryClientProvider>
  );
  try {
    await withReactRoot(node, async () => {
      await settleReact(() => expect(view.status).toBe("ready"));
      // No render offered a row before the room was held.
      expect(renders.filter((render) => render.rows > 0).every((render) => render.ready)).toBe(
        true,
      );

      await act(async () => view.discard(view.items[0].change));
      expect(text(doc)).toContain("red");

      // The row's reader lets go (the file collapsed) and the grace passes: the entry still holds the room.
      await act(async () => collapse());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(room.destroy).not.toHaveBeenCalled();
      expect(pool.peek(ROOM)).toBe(room);
      act(() => view.undoDiscard?.(view.discarded?.[0].id as string));
      expect(text(doc)).toContain("green");

      // Undo spent the entry: nothing holds the room, so it is destroyed.
      await vi.waitFor(() => expect(room.destroy).toHaveBeenCalledTimes(1));
      expect(pool.peek(ROOM)).toBeUndefined();
    });
  } finally {
    release();
    pool.invalidate();
    client.clear();
    doc.destroy();
  }
});
