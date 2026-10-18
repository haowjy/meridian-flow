// @vitest-environment jsdom
/** Real editor, controller, sessions and handoff with held reads and wire acknowledgements. */

import { MessageType } from "@hocuspocus/provider";
import { QueryClient } from "@tanstack/react-query";
import type { Editor } from "@tiptap/core";
import * as encoding from "lib0/encoding";
import { act, useEffect, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { resetBranchCommandRecords } from "@/client/query/branch-command-record";
import { useWorkBranches } from "@/client/query/useWorkBranches";
import type { LiveDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import { createHocuspocusDocumentTransport } from "@/core/transport/hocuspocus-document-transport";
import { DocumentSocketHarness } from "@/core/transport/test-support/DocumentSocketHarness";
import {
  DraftReviewBoundary,
  type useDraftReview,
  useDraftReviewScopeValue,
} from "@/features/draft-review/DraftReviewProvider";
import { listed, previewOf, ReviewTestProviders, work } from "@/test-support/draft-review-scope";
import { createEditorSessions } from "@/test-support/editor-sessions";
import { installEditorShell, ReviewEditorHost } from "@/test-support/editor-shell";
import { settleReact, withReactRoot } from "@/test-support/react-dom-harness";

vi.mock("@/core/transport/dev-transport", () => ({
  buildSameOriginWsUrl: (path: string) => `ws://test${path}`,
}));
vi.mock("@/core/transport/tapped-websocket", async () => {
  const { DocumentSocketHarness } = await import(
    "@/core/transport/test-support/DocumentSocketHarness"
  );
  return { notifyYjsRoomAttached: () => {}, TappedWebSocket: DocumentSocketHarness };
});

let shell: ReturnType<typeof installEditorShell>;
let sessions: ReturnType<typeof createEditorSessions>;
beforeEach(() => {
  sessions = createEditorSessions();
  shell = installEditorShell(realRegistry as unknown as LiveDocumentSessionRegistry);
});
afterEach(async () => {
  shell.dispose();
  await sessions.dispose();
});

const mocks = vi.hoisted(() => ({
  listWorkBranches: vi.fn(),
  getDraftPreview: vi.fn(),
  applyDraftChanges: vi.fn(),
  discardDraft: vi.fn(),
}));

vi.mock("@/client/api/branches-api", () => mocks);

vi.mock("@/features/editor/useInlineReviewSync", () => ({
  useInlineReviewSync: (options: import("./useInlineReviewSync").UseInlineReviewSyncOptions) => {
    useEffect(() => {
      if (options.editor)
        options.onInlineModelAvailable?.("preview-1", options.documentId, options.itemKey);
    }, [options.editor, options.documentId, options.itemKey, options.onInlineModelAvailable]);
  },
}));

const documentId = "document-a";
let review: ReturnType<typeof useDraftReview> | null = null;

/** The editor host's part: hand `EditorView` the requested review; its runtime reports marks. */

let unmountReview!: () => void;
function WorkList() {
  const { branches } = useWorkBranches("project-a", "work-a");
  return <output data-work-list>{branches?.map((draft) => draft.itemKey).join(",")}</output>;
}

function Scope() {
  const [mounted, setMounted] = useState(true);
  unmountReview = () => setMounted(false);
  const value = useDraftReviewScopeValue({ projectId: "project-a", work });
  return (
    <DraftReviewBoundary value={value}>
      <WorkList />
      {mounted && (
        <ReviewEditorHost
          documentId={documentId}
          projectId="project-a"
          session={sessions.get(documentId)}
          observe={(value) => {
            review = value;
          }}
        />
      )}
    </DraftReviewBoundary>
  );
}

const surfaces = () =>
  [...document.querySelectorAll<HTMLElement>("[data-editor-surface]")]
    .filter((wrapper) => !wrapper.classList.contains("hidden"))
    .map((wrapper) => wrapper.dataset.editorSurface);

function renderEditor(run: () => Promise<void>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  testQueryClient = queryClient;
  return withReactRoot(
    <ReviewTestProviders client={queryClient}>
      <Scope />
    </ReviewTestProviders>,
    run,
  );
}

async function reviewOpened() {
  await act(async () => review?.controller.enterInlineReview(documentId, "draft-a"));
  await settleReact(() => expect(surfaces()).toEqual(["review"]));
}

beforeEach(() => {
  vi.clearAllMocks();
  resetBranchCommandRecords();
  review = null;
  heldCarryLookup = null;
  mocks.listWorkBranches.mockResolvedValue({ items: [listed] });
  mocks.getDraftPreview.mockResolvedValue(previewOf("2"));
});

import { draftRoomName } from "@meridian/contracts/protocol";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { draftHandoffHarness } from "@/test-support/draft-handoff-harness";

let nativeRoom: string | null = null;
function syncRoom(room: string) {
  if (room !== nativeRoom) {
    runtime.wire(room).sync();
    return;
  }
  setTimeout(() => {
    const socket = DocumentSocketHarness.instances.at(-1);
    const session = runtime.pool.peek(room);
    if (!socket || !session) throw new Error("Missing native room");
    const baseline = new Y.Doc();
    socket.open();
    socket.syncStep1(room, baseline);
    socket.syncStep2(room, baseline, Y.encodeStateVector(session.document));
    socket.acknowledge(room);
    baseline.destroy();
  }, 0);
}
let testQueryClient: QueryClient;
let heldCarryLookup: (() => Promise<string | null>) | null = null;
let runtime: ReturnType<typeof draftHandoffHarness>;
const realRegistry = {
  retainDraftRooms: (owner: string, rooms: Parameters<typeof runtime.pool.retain>[1]) =>
    runtime.pool.retain(
      owner,
      rooms.map((room) => (heldCarryLookup ? { ...room, currentRoom: heldCarryLookup } : room)),
    ),
  releaseDraftRooms: (owner: string) => runtime.pool.release(owner),
  getDraftRoom: (room: string) => {
    const session = runtime.pool.get(room);
    syncRoom(room);
    return session;
  },
  rebuildDraftRoom: async (room: string) => {
    const session = await runtime.pool.rebuild(room);
    syncRoom(room);
    return session;
  },
};
const draftEditor = (): Editor => {
  const dom = document.querySelector<HTMLElement & { editor?: Editor }>(
    "[data-editor-surface=review] .ProseMirror",
  );
  if (!dom?.editor) throw new Error("no review editor");
  return dom.editor;
};
async function withWriterReview(
  options: { sameRoom?: boolean; native?: boolean; currentRoom?: () => Promise<string | null> },
  run: (
    oldRoom: string,
    newRoom: string,
    old: import("@/core/editor/document-session").DocumentSession,
  ) => Promise<void>,
) {
  vi.useFakeTimers();
  const oldRoom = draftRoomName("writer-loss", 1);
  const newRoom = options.sameRoom ? oldRoom : draftRoomName("writer-loss", 2);
  nativeRoom = options.native ? oldRoom : null;
  heldCarryLookup = options.currentRoom ?? null;
  DocumentSocketHarness.instances.length = 0;
  runtime = draftHandoffHarness(
    options.native
      ? (context) =>
          createHocuspocusDocumentTransport({
            roomName: context.roomKey,
            document: context.document,
            awareness: context.awareness,
          })
      : undefined,
  );
  mocks.getDraftPreview.mockResolvedValue({ ...previewOf("2"), reviewRoomName: oldRoom });
  try {
    await renderEditor(async () => {
      await reviewOpened();
      await act(async () => {
        draftEditor().commands.insertContent("UNACKNOWLEDGED WRITER WORDS");
      });
      const old = runtime.pool.peek(oldRoom);
      if (!old) throw new Error("No source review session");
      expect(old.getSnapshot().serverHasLocalChanges).toBe(false);
      await run(oldRoom, newRoom, old);
    });
  } finally {
    await runtime.dispose();
    testQueryClient.clear();
    vi.useRealTimers();
  }
}

function successor(room: string, ids: string[], listedDraft: boolean) {
  mocks.getDraftPreview.mockResolvedValue({
    ...previewOf(...ids),
    draftGeneration: 2,
    reviewRoomName: room,
  });
  mocks.listWorkBranches.mockResolvedValue({
    items: listedDraft ? [{ ...listed, draftGeneration: 2 }] : [],
  });
}
const previewKey = projectQueryKeys.workBranchPreview("project-a", "work-a", documentId, "draft-a");
const listKey = projectQueryKeys.workBranches("project-a", "work-a");
async function deliver(room: string) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20);
  });
  await act(async () => {
    runtime.wire(room).sync();
    await vi.advanceTimersByTimeAsync(20);
  });
}
async function acknowledge(room: string) {
  await act(async () => {
    runtime.wire(room).ack();
    await vi.advanceTimersByTimeAsync(10);
  });
}

it.each([
  "draft-generation-stale",
  "draft-stale-doc",
] as const)("writer edit survives reentry after %s", async (reason) => {
  await withWriterReview(
    { sameRoom: reason === "draft-stale-doc" },
    async (oldRoom, newRoom, old) => {
      successor(newRoom, ["5"], true);
      await act(async () =>
        runtime.wire(oldRoom).emit({
          kind: "reset",
          reason,
          disposition: reason === "draft-stale-doc" ? "rebuild" : "superseded",
        }),
      );
      await deliver(newRoom);
      expect(surfaces()).toEqual(["review"]);
      expect(old.document.isDestroyed).toBe(true);
      expect(draftEditor().getText()).toContain("UNACKNOWLEDGED WRITER WORDS");
      await acknowledge(newRoom);
    },
  );
});

it("delivers unmounted writing before publishing the draft list after acknowledgement", async () => {
  await withWriterReview({}, async (oldRoom, newRoom, old) => {
    successor(newRoom, ["5"], true);
    await act(async () => {
      await testQueryClient.invalidateQueries({ queryKey: listKey });
      review?.controller.exitInlineReview();
      unmountReview();
      successor(newRoom, [], false);
      await testQueryClient.invalidateQueries({ queryKey: listKey });
      await vi.advanceTimersByTimeAsync(0);
      expect(document.querySelector("[data-work-list]")?.textContent).toBe("");
      expect(surfaces()).toEqual([]);
      await vi.advanceTimersByTimeAsync(10);
      expect(runtime.pool.peek(oldRoom)).toBe(old);
      runtime
        .wire(oldRoom)
        .emit({ kind: "reset", reason: "draft-generation-stale", disposition: "superseded" });
    });
    await deliver(newRoom);
    expect(surfaces()).toEqual([]);
    expect(old.document.isDestroyed).toBe(true);
    expect(runtime.wire(newRoom).sent.length).toBeGreaterThan(0);
    expect(document.querySelector("[data-work-list]")?.textContent).toBe("");
    mocks.listWorkBranches.mockResolvedValue({ items: [{ ...listed, draftGeneration: 2 }] });
    await acknowledge(newRoom);
    expect(document.querySelector("[data-work-list]")?.textContent).toBe("draft-a");
    expect(runtime.pool.peek(newRoom)).toBeUndefined();
  });
});

it("preserves successor typing made before writer carry resolution", async () => {
  await withWriterReview({}, async (oldRoom, newRoom, old) => {
    successor(newRoom, ["5"], true);
    let locate!: (room: string) => void;
    await act(async () => {
      await testQueryClient.invalidateQueries({ queryKey: listKey });
      await vi.advanceTimersByTimeAsync(10);
      expect(runtime.pool.peek(oldRoom)).toBe(old);
      mocks.getDraftPreview.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            locate = (room) =>
              resolve({ ...previewOf("5"), draftGeneration: 2, reviewRoomName: room });
          }),
      );
      runtime
        .wire(oldRoom)
        .emit({ kind: "reset", reason: "draft-generation-stale", disposition: "superseded" });
      await vi.advanceTimersByTimeAsync(20);
    });
    await act(async () => {
      draftEditor().commands.insertContent("SUCCESSOR WORDS");
      locate(newRoom);
    });
    await act(async () => {
      runtime.wire(newRoom).sync();
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(surfaces()).toEqual(["review"]);
    expect(old.document.isDestroyed).toBe(true);
    expect(draftEditor().getText()).toContain("UNACKNOWLEDGED WRITER WORDS");
    expect(draftEditor().getText()).toContain("SUCCESSOR WORDS");
    await acknowledge(newRoom);
  });
});

it("keeps native unacknowledged writing through HTTP-before-reset remote whole Discard", async () => {
  let releaseCarry!: (room: string) => void;
  const successorRead = new Promise<string>((resolve) => {
    releaseCarry = resolve;
  });
  await withWriterReview(
    { native: true, currentRoom: () => successorRead },
    async (oldRoom, newRoom, old) => {
      // Native sends precede outbox bookkeeping. Empty G2 HTTP reads precede
      // the native reset, while the handoff lookup remains held.
      successor(newRoom, [], false);
      await act(async () => {
        await testQueryClient.invalidateQueries({ queryKey: previewKey });
      });
      await act(async () => {
        await testQueryClient.invalidateQueries({ queryKey: listKey });
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(review?.controller.inlineReview?.itemKey).toBe("draft-a");
      expect(document.querySelector("[data-work-list]")?.textContent).toBe("");
      await act(async () => {
        const socket = DocumentSocketHarness.instances.at(-1);
        if (!socket) throw new Error("Missing native socket");
        socket.receive(oldRoom, MessageType.CLOSE, (encoder) =>
          encoding.writeVarString(encoder, "draft-generation-stale"),
        );
      });
      await act(async () => {
        await testQueryClient.invalidateQueries({ queryKey: listKey });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(testQueryClient.getQueryData(previewKey)).toMatchObject({
        draftGeneration: 2,
        operations: [],
      });
      expect(review?.controller.inlineReview?.itemKey).toBe("draft-a");
      expect(document.querySelector("[data-work-list]")?.textContent).toBe("");
      await act(async () => {
        releaseCarry(newRoom);
      });
      await deliver(newRoom);
      expect(old.document.isDestroyed).toBe(true);
      successor(newRoom, ["writer"], true);
      mocks.getDraftPreview.mockResolvedValue({
        ...previewOf("writer"),
        operations: [{ ...previewOf("writer").operations[0], kind: "writer" }],
        draftGeneration: 2,
        reviewRoomName: newRoom,
      });
      await acknowledge(newRoom);
      expect(surfaces()).toEqual(["review"]);
      expect(review?.controller.inlineReview?.draftGeneration).toBe(2);
      expect(testQueryClient.getQueryData(previewKey)).toMatchObject({
        operations: [expect.objectContaining({ kind: "writer" })],
      });
      expect(draftEditor().getText()).toContain("UNACKNOWLEDGED WRITER WORDS");
      expect(document.querySelector("[data-work-list]")?.textContent).toBe("draft-a");
    },
  );
});
