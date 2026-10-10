// @vitest-environment jsdom
/** Real editor, controller, sessions and handoff with held reads and wire acknowledgements. */

import { MessageType } from "@hocuspocus/provider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Editor } from "@tiptap/core";
import * as encoding from "lib0/encoding";
import { act, useEffect, useState } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import { useWorkDrafts } from "@/client/query/useWorkDrafts";
import { createHocuspocusDocumentTransport } from "@/core/transport/hocuspocus-document-transport";
import { DocumentSocketHarness } from "@/core/transport/test-support/DocumentSocketHarness";
import {
  DraftReviewBoundary,
  useDraftReview,
  useDraftReviewScopeValue,
} from "@/features/draft-review/DraftReviewProvider";
import { listed, previewOf, work } from "@/test-support/draft-review-scope";
import { sessionFor } from "@/test-support/editor-session-fakes";
import { withReactRoot } from "@/test-support/react-dom-harness";

vi.mock("@/core/transport/dev-transport", () => ({
  buildSameOriginWsUrl: (path: string) => `ws://test${path}`,
}));
vi.mock("@/core/transport/tapped-websocket", async () => {
  const { DocumentSocketHarness } = await import(
    "@/core/transport/test-support/DocumentSocketHarness"
  );
  return { notifyYjsRoomAttached: () => {}, TappedWebSocket: DocumentSocketHarness };
});

const mocks = vi.hoisted(() => ({
  listWorkDrafts: vi.fn(),
  getDraftPreview: vi.fn(),
  applyDraftChanges: vi.fn(),
  discardDraft: vi.fn(),
}));

vi.mock("@/client/api/drafts-api", () => mocks);
vi.mock("@/client/query/useContextCatalog", () => ({
  contextCatalogScope: () => ({ kind: "project", projectId: "project-a" }),
  useContextCatalogView: () => ({
    catalog: null,
    isError: false,
    isFetching: false,
    refetch: () => {},
  }),
  projectCatalogView: () => ({ findDocument: () => null }),
}));
vi.mock("@/client/query/useProjectThreads", () => ({
  useProjectThreads: () => ({ threads: [], isError: false, isFetching: false }),
}));
vi.mock("@/client/query/useWorks", () => ({
  useWorks: () => ({ noWork: { id: "no-work", slug: null, archivedAt: null }, works: [] }),
}));
vi.mock("@/features/change-trail/trail-detail-query", () => ({
  usePrefetchTrailDetails: () => {},
}));
vi.mock("@/features/project/context/account-feature-context", () => ({
  useContextRemovalCoordinator: () => ({ promoteAppliedDraft: vi.fn(), discardDraft: vi.fn() }),
  useOptionalAccountResourceReplica: () => null,
  useLiveDocumentSessionRegistry: () => realRegistry,
  useAccountResourceProjection: () => ({ snapshot: null, records: [], error: null }),
}));
vi.mock("@/features/links", async () => ({
  useLinkFollower: (await import("@/features/links/use-link-follower")).useLinkFollower,
  useLinkableDocuments: () => ({ documents: [], revision: "", complete: false }),
}));
vi.mock("@/features/editor/references/useReferenceBrowserCatalog", () => ({
  useReferenceBrowserCatalog: () => null,
}));
vi.mock("@/features/editor/useInlineReviewSync", () => ({
  useInlineReviewSync: (options: import("./useInlineReviewSync").UseInlineReviewSyncOptions) => {
    useEffect(() => {
      if (options.editor)
        options.onInlineModelAvailable?.("preview-1", options.documentId, options.draftId);
    }, [options.editor, options.documentId, options.draftId, options.onInlineModelAvailable]);
  },
}));
vi.mock("@/features/editor/useInlineReviewFocus", () => ({ useInlineReviewFocus: () => {} }));
vi.mock("@/features/editor/SyncStatus", () => ({ SyncStatus: () => null }));
vi.mock("@/features/editor/chrome/chrome-surfaces", () => ({ EDITOR_CHROME_SURFACES: [] }));

const { EditorView } = await import("@/features/editor/EditorView");

const documentId = "document-a";
let review: ReturnType<typeof useDraftReview> | null = null;

/** The editor host's part: hand `EditorView` the requested review; its runtime reports marks. */
function Host() {
  const value = useDraftReview();
  review = value;
  const { inlineReview } = value.controller;
  return (
    <EditorView
      documentId={documentId}
      projectId="project-a"
      session={sessionFor(documentId)}
      reviewDraftId={inlineReview?.draftId}
    />
  );
}

let unmountReview!: () => void;
function WorkList() {
  const { drafts } = useWorkDrafts("project-a", "work-a");
  return <output data-work-list>{drafts?.map((draft) => draft.draftId).join(",")}</output>;
}

function Scope() {
  const [mounted, setMounted] = useState(true);
  unmountReview = () => setMounted(false);
  const value = useDraftReviewScopeValue({ projectId: "project-a", work });
  return (
    <DraftReviewBoundary value={value}>
      <WorkList />
      {mounted && <Host />}
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
    <QueryClientProvider client={queryClient}>
      <Scope />
    </QueryClientProvider>,
    run,
  );
}

async function reviewOpened() {
  await act(async () => review?.controller.enterInlineReview(documentId, "draft-a"));
  // Drive setup and the native room handshake under React's flush boundary.
  for (let step = 0; step < 40; step++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25);
    });
    if (surfaces().join(",") === "review") break;
  }
  expect(surfaces()).toEqual(["review"]);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDraftCommandRecords();
  review = null;
  heldCarryLookup = null;
  mocks.listWorkDrafts.mockResolvedValue({ drafts: [listed] });
  mocks.getDraftPreview.mockResolvedValue(previewOf("2"));
});

import { branchRoomName } from "@meridian/contracts/protocol";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { branchHandoffHarness } from "@/test-support/branch-handoff-harness";

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
let runtime: ReturnType<typeof branchHandoffHarness>;
const realRegistry = {
  retainBranchRooms: (owner: string, rooms: Parameters<typeof runtime.pool.retain>[1]) =>
    runtime.pool.retain(
      owner,
      rooms.map((room) => (heldCarryLookup ? { ...room, currentRoom: heldCarryLookup } : room)),
    ),
  releaseBranchRooms: (owner: string) => runtime.pool.release(owner),
  getBranchRoom: (room: string) => {
    const session = runtime.pool.get(room);
    syncRoom(room);
    return session;
  },
  rebuildBranchRoom: async (room: string) => {
    const session = await runtime.pool.rebuild(room);
    syncRoom(room);
    return session;
  },
};
const branchEditor = (): Editor => {
  const dom = document.querySelector<HTMLElement & { editor?: Editor }>(
    "[data-editor-surface=review] .ProseMirror",
  );
  if (!dom?.editor) throw new Error("no review editor");
  return dom.editor;
};
it.each([
  "branch-generation-stale",
  "branch-stale-doc",
  "list",
  "successor typing",
  "remote whole Discard",
])("writer edit survives reentry after %s", async (reason) => {
  vi.useFakeTimers();
  nativeRoom = reason === "remote whole Discard" ? branchRoomName("writer-loss", 1) : null;
  DocumentSocketHarness.instances.length = 0;
  runtime = branchHandoffHarness(
    nativeRoom
      ? (context) =>
          createHocuspocusDocumentTransport({
            roomName: context.roomKey,
            document: context.document,
            awareness: context.awareness,
          })
      : undefined,
  );
  const oldRoom = branchRoomName("writer-loss", 1);
  const newRoom = reason === "branch-stale-doc" ? oldRoom : branchRoomName("writer-loss", 2);
  let releaseCarry!: (room: string) => void;
  if (reason === "remote whole Discard") {
    // Native sends precede outbox bookkeeping. Empty G2 reads arrive over HTTP
    // before the held native reset, while the handoff lookup stays pending.
    const successorRead = new Promise<string>((resolve) => {
      releaseCarry = resolve;
    });
    heldCarryLookup = () => successorRead;
  }
  mocks.getDraftPreview.mockResolvedValue({ ...previewOf("2"), reviewRoomName: oldRoom });
  try {
    await renderEditor(async () => {
      await reviewOpened();
      await act(async () => {
        branchEditor().commands.insertContent("UNACKNOWLEDGED WRITER WORDS");
      });
      const old = runtime.pool.peek(oldRoom);
      if (!old) throw new Error("No source review session");
      expect(old.getSnapshot().serverHasLocalChanges).toBe(false);
      let locate!: (room: string) => void;

      mocks.getDraftPreview.mockResolvedValue({
        ...previewOf(...(reason === "remote whole Discard" ? [] : ["5"])),
        draftGeneration: 2,
        reviewRoomName: newRoom,
      });
      mocks.listWorkDrafts.mockResolvedValue({
        drafts: reason === "remote whole Discard" ? [] : [{ ...listed, draftGeneration: 2 }],
      });
      if (reason === "remote whole Discard") {
        mocks.getDraftPreview.mockResolvedValue({
          ...previewOf(),
          draftGeneration: 2,
          reviewRoomName: newRoom,
        });
        await act(async () => {
          await testQueryClient.invalidateQueries({
            queryKey: projectQueryKeys.workDraftPreview(
              "project-a",
              "work-a",
              documentId,
              "draft-a",
            ),
          });
        });
        await act(async () => {
          await testQueryClient.invalidateQueries({
            queryKey: projectQueryKeys.workDrafts("project-a", "work-a"),
          });
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(review?.controller.inlineReview?.draftId).toBe("draft-a");
        expect(document.querySelector("[data-work-list]")?.textContent).toBe("");
      }
      await act(async () => {
        if (reason === "list" || reason === "successor typing") {
          await testQueryClient.invalidateQueries({
            queryKey: projectQueryKeys.workDrafts("project-a", "work-a"),
          });
          if (reason === "list") {
            review?.controller.exitInlineReview();
            unmountReview();
            mocks.listWorkDrafts.mockResolvedValue({ drafts: [] });
            mocks.getDraftPreview.mockResolvedValue({
              ...previewOf(),
              draftGeneration: 2,
              reviewRoomName: newRoom,
            });
            await testQueryClient.invalidateQueries({
              queryKey: projectQueryKeys.workDrafts("project-a", "work-a"),
            });
            await vi.advanceTimersByTimeAsync(0);
            expect(document.querySelector("[data-work-list]")?.textContent).toBe("");
            expect(surfaces()).toEqual([]);
          }
          await vi.advanceTimersByTimeAsync(10);
          expect(runtime.pool.peek(oldRoom)).toBe(old);
        }
        if (reason === "successor typing")
          mocks.getDraftPreview.mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                locate = (room) =>
                  resolve({ ...previewOf("5"), draftGeneration: 2, reviewRoomName: room });
              }),
          );
        if (reason === "remote whole Discard") {
          const socket = DocumentSocketHarness.instances.at(-1);
          if (!socket) throw new Error("Missing native socket");
          socket.receive(oldRoom, MessageType.CLOSE, (encoder) =>
            encoding.writeVarString(encoder, "branch-generation-stale"),
          );
        } else
          runtime.wire(oldRoom).emit({
            kind: "reset",
            reason: reason === "branch-stale-doc" ? "branch-stale-doc" : "branch-generation-stale",
            disposition: reason === "branch-stale-doc" ? "rebuild" : "superseded",
          });
      });
      if (reason === "remote whole Discard") {
        await act(async () => {
          await testQueryClient.invalidateQueries({
            queryKey: projectQueryKeys.workDrafts("project-a", "work-a"),
          });
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(
          testQueryClient.getQueryData(
            projectQueryKeys.workDraftPreview("project-a", "work-a", documentId, "draft-a"),
          ),
        ).toMatchObject({ draftGeneration: 2, operations: [] });
        expect(review?.controller.inlineReview?.draftId).toBe("draft-a");
        expect(document.querySelector("[data-work-list]")?.textContent).toBe("");
        mocks.getDraftPreview.mockResolvedValue({
          ...previewOf(),
          draftGeneration: 2,
          reviewRoomName: newRoom,
        });
      }
      await act(async () => {
        if (reason === "remote whole Discard") releaseCarry(newRoom);
        await vi.advanceTimersByTimeAsync(20);
      });
      if (reason === "successor typing") {
        await act(async () => {
          branchEditor().commands.insertContent("SUCCESSOR WORDS");
          locate(newRoom);
        });
      }
      await act(async () => {
        runtime.wire(newRoom).sync();
        await vi.advanceTimersByTimeAsync(20);
      });
      if (reason !== "remote whole Discard")
        expect(surfaces()).toEqual(reason === "list" ? [] : ["review"]);
      expect(old.document.isDestroyed).toBe(true);
      if (reason !== "list" && reason !== "remote whole Discard")
        expect(branchEditor().getText()).toContain("UNACKNOWLEDGED WRITER WORDS");
      if (reason === "successor typing")
        expect(branchEditor().getText()).toContain("SUCCESSOR WORDS");
      await act(async () => {
        if (reason === "list") {
          expect(runtime.wire(newRoom).sent.length).toBeGreaterThan(0);
          expect(document.querySelector("[data-work-list]")?.textContent).toBe("");
          mocks.listWorkDrafts.mockResolvedValue({ drafts: [{ ...listed, draftGeneration: 2 }] });
        }
        if (reason === "remote whole Discard") {
          mocks.listWorkDrafts.mockResolvedValue({ drafts: [{ ...listed, draftGeneration: 2 }] });
          mocks.getDraftPreview.mockResolvedValue({
            ...previewOf("writer"),
            operations: [{ ...previewOf("writer").operations[0], kind: "writer" }],
            draftGeneration: 2,
            reviewRoomName: newRoom,
          });
        }
        runtime.wire(newRoom).ack();
        await vi.advanceTimersByTimeAsync(10);
      });
      if (reason === "remote whole Discard") {
        expect(surfaces()).toEqual(["review"]);
        expect(review?.controller.inlineReview?.draftGeneration).toBe(2);
        expect(
          testQueryClient.getQueryData(
            projectQueryKeys.workDraftPreview("project-a", "work-a", documentId, "draft-a"),
          ),
        ).toMatchObject({ operations: [expect.objectContaining({ kind: "writer" })] });
        expect(branchEditor().getText()).toContain("UNACKNOWLEDGED WRITER WORDS");
        expect(document.querySelector("[data-work-list]")?.textContent).toBe("draft-a");
      }
      if (reason === "list") {
        expect(document.querySelector("[data-work-list]")?.textContent).toBe("draft-a");
        expect(runtime.pool.peek(newRoom)).toBeUndefined();
      }
    });
  } finally {
    await runtime.dispose();
    testQueryClient.clear();
    vi.useRealTimers();
  }
});
