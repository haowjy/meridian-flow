// @vitest-environment node
/**
 * The expanded-row Discard on real hooks over the real branch-room pool. It protects: a rendered, enabled
 * row whose Discard has nothing to write into (readiness before the room is held), and an Undo that
 * outlives its room (the reader let go on collapse while the Discard entry stayed).
 */

import { branchRoomName } from "@meridian/contracts/protocol";
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, useState } from "react";
import { expect, it, vi } from "vitest";
import * as Y from "yjs";
import { draftAttributionQueryOptions } from "@/client/query/useDraftAttribution";
import { draftMetaQueryOptions } from "@/client/query/useDraftMeta";
import { BranchRoomPool } from "@/core/editor/branch-room-pool";
import { readBranchRoom } from "@/core/editor/branch-room-read";
import { DocumentSessionTeardownOwner } from "@/core/editor/document-session-teardown-owner";
import { seedReviewBase } from "@/test-support/inline-review-editor";
import { settleReact, withReactRoot } from "@/test-support/react-dom-harness";
import { projectRoom } from "./review-frame";
import { reviewChanges } from "./review-model";
import { retainReviewRuntime, reviewRuntimeOf } from "./review-runtime";
import { useDraftView } from "./useDraftView";
import { useHeadlessDiscards } from "./useHeadlessDiscards";

// One port object for the test's life, as the account's registry is: a new one per render would re-run effects.
const registry = vi.hoisted(() => ({ port: {} as Record<string, unknown> }));
vi.mock("@/features/project/context/account-feature-context", () => ({
  useLiveDocumentSessionRegistry: () => registry.port,
}));

// The cold collapsed Discard reads the item's metadata and attribution over the network.
const api = vi.hoisted(() => ({ meta: vi.fn(), attribution: vi.fn() }));
vi.mock("@/client/api/drafts-api", () => ({
  getDraftMeta: api.meta,
  getDraftAttribution: api.attribution,
}));

const ROOM = branchRoomName("draft");
const draft = { projectId: "p", workId: "w", documentId: "doc", itemKey: "draft:doc" };
const file = { documentId: "doc", draft: { itemKey: "draft:doc" } } as never;
const text = (doc: Y.Doc) =>
  (doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).get(0) as Y.XmlElement).toString();

function seededDoc() {
  const doc = new Y.Doc({ gc: false });
  const paragraph = new Y.XmlElement("paragraph");
  const run = new Y.XmlText();
  paragraph.insert(0, [run]);
  run.insert(0, "green");
  doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).insert(0, [paragraph]);
  seedReviewBase(doc, ["red"]);
  return doc;
}

/** A session stand-in: tells a subscriber its current snapshot at once, as a real one does, and can be reset. */
function fakeRoom(options: { synced?: Promise<void>; destroy?: () => Promise<void> } = {}) {
  const listeners = new Set<(snapshot: unknown) => void>();
  let snapshot: Record<string, unknown> = { status: "synced" };
  // Like a real session, a pending sync ends when destruction begins.
  let ended!: () => void;
  const lifecycle = new Promise<void>((resolve) => (ended = resolve));
  return {
    document: seededDoc(),
    getSnapshot: () => snapshot as never,
    subscribe: (listener: (snapshot: unknown) => void) => {
      listeners.add(listener);
      listener(snapshot);
      return () => listeners.delete(listener);
    },
    whenSynced: () => Promise.race([options.synced ?? Promise.resolve(), lifecycle]),
    hasUnacknowledgedEdits: () => false,
    destroy: vi.fn(() => {
      ended();
      return (options.destroy ?? (async () => {}))();
    }),
    refuse() {
      snapshot = { status: "synced", connectionState: { kind: "reset", disposition: "refused" } };
      for (const listener of [...listeners]) listener(snapshot);
    },
  };
}

function fixture(rooms: ReturnType<typeof fakeRoom>[] = [fakeRoom()]) {
  const doc = rooms[0].document;
  const room = rooms[0];
  // The real pool: a room lives while any owner retains it and is destroyed after the grace once none does.
  const pool = new BranchRoomPool({
    teardownGraceMs: 1,
    teardownOwner: new DocumentSessionTeardownOwner(() => new Error("unavailable")),
    openSession: () => rooms.shift() as never,
  });
  registry.port = {
    retainBranchRooms: (owner: string, keys: readonly string[]) => pool.retain(owner, keys),
    releaseBranchRooms: (owner: string) => pool.release(owner),
    getBranchRoom: (roomKey: string) => pool.get(roomKey),
    rebuildBranchRoom: (roomKey: string) => pool.rebuild(roomKey),
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
    revision: [...Y.encodeSnapshot(Y.snapshot(doc))],
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

it("a reader joins a room's rebuild instead of throwing, and a pending read or landed Discard never outlives its refused session", async () => {
  let finishTeardown!: () => void;
  const held = new Promise<void>((resolve) => (finishTeardown = resolve));
  let firstSynced!: () => void;
  const pending = new Promise<void>((resolve) => (firstSynced = resolve));
  const first = fakeRoom({ synced: pending, destroy: () => held });
  const second = fakeRoom();
  const { client, pool } = fixture([first, second]);
  const reader = readBranchRoom(registry.port as never, ROOM);
  const waiting = reader.synced();
  let discards!: ReturnType<typeof useHeadlessDiscards>;
  function Probe() {
    discards = useHeadlessDiscards("p", "w");
    return null;
  }
  try {
    await withReactRoot(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
      async () => {
        // The server refuses the first session's edits while its teardown is held open.
        first.refuse();
        expect(reader.state().kind).toBe("rebuilding");
        // Another reader arriving during the quarantine joins the rebuild; it does not throw.
        const joiner = readBranchRoom(registry.port as never, ROOM);
        expect(joiner.state().kind).toBe("rebuilding");
        finishTeardown();
        // The pending read resolves with the replacement, never the retired session.
        await expect(waiting).resolves.toBe(second);
        await expect(joiner.synced()).resolves.toBe(second);
        // The retired transport is destroyed once, though every reader asked.
        expect(first.destroy).toHaveBeenCalledTimes(1);
        firstSynced();

        // A landed Discard is the history of its session: once refused, it reads failed with no Undo.
        const file = { documentId: "doc", draft: { itemKey: "draft:doc" } } as never;
        const change = reviewChanges(projectRoom(second.document))[0];
        await act(async () => discards.discardChange(file, change, 0, ROOM));
        expect(discards.entries[0].phase).toBe("discarded");
        second.refuse();
        await settleReact(() => expect(discards.entries[0].phase).toBe("failed"));
        act(() => discards.undo(discards.entries[0].id));
        expect(text(second.document)).toContain("red");
        joiner.dispose();
      },
    );
  } finally {
    reader.dispose();
    pool.invalidate();
    client.clear();
  }
});

it("a cold collapsed chat Discard survives the row's metadata observer unmounting mid-read", async () => {
  const room = fakeRoom();
  const { client, pool } = fixture([room]);
  client.removeQueries();
  api.meta.mockImplementation(
    (_p: string, _w: string, _d: string, _i: string, signal?: AbortSignal) =>
      new Promise((resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
        setTimeout(
          () =>
            resolve({
              kind: "text",
              draftId: "draft",
              itemKey: "draft:doc",
              documentId: "doc",
              roomName: ROOM,
              isNew: false,
              wholeItem: false,
              hasChanges: true,
            }),
          5,
        );
      }),
  );
  api.attribution.mockResolvedValue({
    itemKey: "draft:doc",
    userId: "user-1",
    revision: [...Y.encodeSnapshot(Y.snapshot(room.document))],
    edits: [],
  });
  let discards!: ReturnType<typeof useHeadlessDiscards>;
  // The collapsed dock row holds an idle observer on the metadata query and is replaced by the Discard's entry.
  function Row() {
    useQuery({ ...draftMetaQueryOptions(draft), enabled: false });
    return null;
  }
  function Probe() {
    discards = useHeadlessDiscards("p", "w");
    return discards.entries.length === 0 ? <Row /> : null;
  }
  try {
    await withReactRoot(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
      async () => {
        await act(async () =>
          discards.discardFile({ ...(file as object), itemKey: "draft:doc" } as never, "thread"),
        );
        await settleReact(() =>
          expect(discards.entries.some((entry) => entry.phase === "pending")).toBe(false),
        );
        // Nothing is attributed to the chat, so the row clears; a cancelled read would have left it failed.
        expect(api.attribution).toHaveBeenCalled();
        expect(discards.entries).toEqual([]);
      },
    );
  } finally {
    pool.invalidate();
    client.clear();
  }
});
