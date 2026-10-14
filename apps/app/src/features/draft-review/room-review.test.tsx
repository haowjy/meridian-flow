// @vitest-environment node
/**
 * The expanded-row Discard on real hooks over a supplied registry port. It protects: a rendered, enabled
 * row whose Discard has nothing to write into (readiness before the room is held), and an Undo that
 * outlives its room (the reader let go on collapse while the Discard entry stayed).
 */

import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { expect, it, vi } from "vitest";
import * as Y from "yjs";
import { draftAttributionQueryOptions } from "@/client/query/useDraftAttribution";
import { draftMetaQueryOptions } from "@/client/query/useDraftMeta";
import { seedReviewBase } from "@/test-support/inline-review-editor";
import { settleReact, withReactRoot } from "@/test-support/react-dom-harness";
import { retainReviewRuntime, reviewRuntimeOf } from "./review-runtime";
import { useDraftView } from "./useDraftView";
import { useHeadlessDiscards } from "./useHeadlessDiscards";

const registry = vi.hoisted(() => {
  const state = {
    retained: new Map<string, readonly string[]>(),
    room: null as unknown,
    // One object for the test's life, as the account's registry is: a new one per render would re-run effects.
    port: {} as Record<string, unknown>,
  };
  state.port = {
    retainBranchRooms: (owner: string, rooms: readonly string[]) =>
      state.retained.set(owner, rooms),
    releaseBranchRooms: (owner: string) => state.retained.delete(owner),
    getBranchRoom: () => state.room,
  };
  return state;
});
vi.mock("@/features/project/context/account-feature-context", () => ({
  useLiveDocumentSessionRegistry: () => registry.port,
}));

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
  };
  registry.room = room;
  registry.retained.clear();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(draftMetaQueryOptions(draft).queryKey, {
    kind: "text",
    draftId: "draft",
    itemKey: "draft:doc",
    documentId: "doc",
    roomName: "branch:draft",
    isNew: false,
    wholeItem: false,
    hasChanges: true,
  });
  client.setQueryData(draftAttributionQueryOptions(draft).queryKey, {
    itemKey: "draft:doc",
    edits: [],
  });
  return { doc, room, client };
}

it("a row another surface's runtime made ready is actionable only once its room is held; the entry keeps the room for Undo", async () => {
  const { doc, room, client } = fixture();
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
  const node = (enabled: boolean) => (
    <QueryClientProvider client={client}>
      <Probe enabled={enabled} />
    </QueryClientProvider>
  );
  await withReactRoot(node(true), async () => {
    await settleReact(() => expect(view.status).toBe("ready"));
    // No render offered a row before the room was held.
    expect(renders.filter((render) => render.rows > 0).every((render) => render.ready)).toBe(true);

    await act(async () => view.discard(view.items[0].change));
    expect(text(doc)).toContain("red");
    const leasedBy = (prefix: string) =>
      [...registry.retained].find(([owner]) => owner.startsWith(prefix))?.[1];
    expect(leasedBy("headless-discard")).toEqual(["branch:draft"]);

    // The row's reader lets go (the file collapsed): the entry still holds the room, so Undo still lands.
    registry.retained.delete(
      [...registry.retained.keys()].find((k) => k.startsWith("room-review")) ?? "",
    );
    expect(leasedBy("headless-discard")).toEqual(["branch:draft"]);
    act(() => view.undoDiscard?.(view.discarded?.[0].id as string));
    expect(text(doc)).toContain("green");
    expect(leasedBy("headless-discard")).toBeUndefined();
  });
  release();
});
