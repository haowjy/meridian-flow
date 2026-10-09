// @vitest-environment jsdom
/** Real provider, editor paint, session and pool replacement. Only HTTP and the wire are fake. */

import { branchRoomName, WS_CLOSE } from "@meridian/contracts/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { PaintCapture, PaintHold, usePaintPending } from "@/components/app/PaintHold";
import { BranchRoomPool } from "@/core/editor/branch-room-pool";
import {
  DocumentSession,
  type DocumentSessionConnectionState,
} from "@/core/editor/document-session";
import { DocumentSessionTeardownOwner } from "@/core/editor/document-session-teardown-owner";
import {
  DraftReviewBoundary,
  useDraftReview,
  useDraftReviewScopeValue,
} from "@/features/draft-review/DraftReviewProvider";
import { useReviewChanges } from "@/features/draft-review/useReviewChanges";
import {
  applied,
  change,
  deferredReviewAnswer,
  discarded,
  draftA,
  listed,
  previewOf,
  work,
} from "@/test-support/draft-review-scope";
import { sessionFor } from "@/test-support/editor-session-fakes";
import { withReactRoot } from "@/test-support/react-dom-harness";

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
  useLiveDocumentSessionRegistry: () => poolRegistry,
  useAccountResourceProjection: () => ({ snapshot: null, records: [], error: null }),
}));
vi.mock("@/features/links", async () => ({
  useLinkFollower: (await import("@/features/links/use-link-follower")).useLinkFollower,
  useLinkableDocuments: () => ({ documents: [], revision: "", complete: false }),
}));
vi.mock("./references/useReferenceBrowserCatalog", () => ({
  useReferenceBrowserCatalog: () => null,
}));
vi.mock("./useInlineReviewSync", () => ({ useInlineReviewSync: () => {} }));
vi.mock("./useInlineReviewFocus", () => ({ useInlineReviewFocus: () => {} }));
vi.mock("./SyncStatus", () => ({ SyncStatus: () => null }));
vi.mock("./chrome/chrome-surfaces", () => ({ EDITOR_CHROME_SURFACES: [] }));

const { EditorView } = await import("./EditorView");

const documentId = "document-a";
const transportStatus = new Map<string, (state: DocumentSessionConnectionState) => void>();
const syncs = new Map<string, ReturnType<typeof deferredReviewAnswer<void>>>();
const teardowns = new Map<string, ReturnType<typeof deferredReviewAnswer<void>>>();
const pool = new BranchRoomPool({
  teardownGraceMs: 1,
  teardownOwner: new DocumentSessionTeardownOwner(() => new Error("room is retiring")),
  openSession: (roomKey) =>
    new DocumentSession({
      roomKey,
      persistence: { kind: "none" },
      transportFactory: () => ({
        unacknowledgedUpdates: () => null,
        synced: !syncs.has(roomKey),
        whenSynced: syncs.get(roomKey)?.promise ?? Promise.resolve(),
        subscribeStatus: (listener) => {
          transportStatus.set(roomKey, listener);
          listener({ kind: "connected" });
          return () => {};
        },
        subscribeAccess: (listener) => {
          listener("edit");
          return () => {};
        },
        subscribeServerAcknowledgement: (listener) => {
          listener(false);
          return () => {};
        },
        destroy: () => teardowns.get(roomKey)?.promise,
      }),
    }),
});
const poolRegistry = {
  retainBranchRooms: (owner: string, rooms: Parameters<typeof pool.retain>[1]) =>
    pool.retain(owner, rooms),
  releaseBranchRooms: (owner: string) => pool.release(owner),
  getBranchRoom: (room: string) => pool.get(room),
  rebuildBranchRoom: (room: string) => pool.rebuild(room),
};

let review: ReturnType<typeof useDraftReview> | null = null;
let draftOnly = false;
let supplyMarks = true;

function Host() {
  const value = useDraftReview();
  review = value;
  const { inlineReview, reviewRoomName, inlineReviewModelAvailable } = value.controller;
  useEffect(() => {
    if (supplyMarks && inlineReview && reviewRoomName) {
      inlineReviewModelAvailable("preview-1", inlineReview.documentId, inlineReview.draftId);
    }
  }, [inlineReview, reviewRoomName, inlineReviewModelAvailable]);
  return (
    <EditorView
      draftOnly={draftOnly}
      documentId={documentId}
      projectId="project-a"
      session={draftOnly ? undefined : sessionFor(documentId)}
      reviewWorkId="work-a"
      reviewDraftId={inlineReview?.draftId}
      reviewRoomName={reviewRoomName ?? undefined}
      onReviewSessionUnavailable={value.controller.exitInlineReview}
    />
  );
}

function Scope() {
  const value = useDraftReviewScopeValue({ projectId: "project-a", work });
  return (
    <DraftReviewBoundary value={value}>
      <PaintHold status="Opening review">
        <ReviewChromeWitness />
        <Host />
      </PaintHold>
    </DraftReviewBoundary>
  );
}

const surfaces = () =>
  [...document.querySelectorAll<HTMLElement>("[data-editor-surface]")]
    .filter(
      (wrapper) => !wrapper.classList.contains("hidden") && !wrapper.closest("[data-paint-hold]"),
    )
    .map((wrapper) => wrapper.dataset.editorSurface);

beforeEach(() => {
  vi.useFakeTimers();
  syncs.clear();
  teardowns.clear();
  draftOnly = false;
  supplyMarks = true;
  vi.clearAllMocks();
  resetDraftCommandRecords();
  review = null;
  mocks.listWorkDrafts.mockResolvedValue({ drafts: [listed] });
});

afterEach(() => {
  pool.invalidate();
  vi.useRealTimers();
});

async function settled(check: () => void) {
  for (let i = 0; i < 40; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25);
    });
    try {
      check();
      return;
    } catch (error) {
      if (i === 39) throw error;
    }
  }
}
const mounted = () => {
  const wrapper = [...document.querySelectorAll<HTMLElement>("[data-editor-surface]")].find(
    (node) => !node.classList.contains("hidden") && !node.closest("[data-paint-hold]"),
  );
  const node = wrapper?.querySelector<HTMLElement & { editor?: import("@tiptap/core").Editor }>(
    ".ProseMirror",
  );
  if (!node?.editor) throw new Error("No painted editor");
  return node.editor;
};
async function run(run: (client: QueryClient, room: string) => Promise<void>, enter = true) {
  const room = branchRoomName("review-owner", 1);
  mocks.getDraftPreview.mockResolvedValue({ ...previewOf("2"), reviewRoomName: room });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await withReactRoot(
    <QueryClientProvider client={client}>
      <Scope />
    </QueryClientProvider>,
    async () => {
      if (enter) {
        await act(async () => review?.controller.enterInlineReview(documentId, draftA.draftId));
        await settled(() => expect(surfaces()).toEqual(["review"]));
      } else if (!draftOnly) await settled(() => expect(mounted()).toBeTruthy());
      await run(client, room);
    },
    { drainMacrotask: false },
  );
  client.clear();
}

it.each([
  "superseded",
  "rebuild",
  "refused",
] as const)("%s keeps painted prose inert until its replacement paints", async (disposition) => {
  await run(async (_client, oldRoom) => {
    const oldSession = review?.roomOwner.session;
    const oldEditor = mounted();
    await act(async () => oldEditor.commands.insertContent("The held review."));
    const live = sessionFor(documentId).document;
    const room = disposition === "superseded" ? branchRoomName("review-owner", 2) : oldRoom;
    const sync = deferredReviewAnswer<void>();
    syncs.set(room, sync);
    if (disposition === "superseded") {
      const read = deferredReviewAnswer<ReturnType<typeof previewOf>>();
      mocks.getDraftPreview.mockReturnValue(read.promise);
      await act(async () =>
        transportStatus.get(oldRoom)?.({
          kind: "reset",
          disposition,
          reason: WS_CLOSE.BRANCH_GENERATION_STALE.reason,
        }),
      );
      expect(document.querySelector("[data-paint-hold]")?.textContent).toContain(
        "The held review.",
      );
      mocks.getDraftPreview.mockResolvedValue({
        ...previewOf("3"),
        draftGeneration: 2,
        reviewRoomName: room,
      });
      mocks.listWorkDrafts.mockResolvedValue({ drafts: [{ ...listed, draftGeneration: 2 }] });
      await act(async () =>
        read.resolve({ ...previewOf("3"), draftGeneration: 2, reviewRoomName: room }),
      );
    } else {
      await act(async () =>
        transportStatus.get(oldRoom)?.({
          kind: "reset",
          disposition,
          reason: disposition === "refused" ? "access-changed" : WS_CLOSE.BRANCH_STALE.reason,
        }),
      );
    }
    await settled(() => expect(review?.roomOwner.session).not.toBeNull());
    const frozen = document.querySelector<HTMLElement>("[data-paint-hold]");
    expect(frozen?.hasAttribute("inert")).toBe(true);
    expect(frozen?.textContent).toContain("The held review.");
    expect(frozen?.querySelector("[contenteditable=true]")).toBeTruthy(); // Copied DOM is inert, not another editor.
    expect(surfaces()).toEqual([]);
    await act(async () => sync.resolve());
    await settled(() => expect(surfaces()).toEqual(["review"]));
    expect(document.querySelector("[data-paint-hold]")).toBeNull();
    expect(mounted()).not.toBe(oldEditor);
    expect(review?.roomOwner.inputEligible).toBe(true);
    expect(sessionFor(documentId).document).toBe(live);
    if (oldSession) await act(async () => review?.roomOwner.reportPaint(oldSession));
    expect(review?.roomOwner.inputEligible).toBe(true);
  });
});

it("draft-only has no live fallback, including closed completion and terminal failure", async () => {
  draftOnly = true;
  mocks.listWorkDrafts.mockResolvedValue({ drafts: [{ ...listed, isNewDocument: true }] });
  await run(async (_client, room) => {
    const answer = deferredReviewAnswer<ReturnType<typeof applied>>();
    mocks.applyDraftChanges.mockReturnValue(answer.promise);
    let done: Promise<unknown> | undefined;
    await act(async () => {
      done = review?.controller.applyChanges(draftA, change("2"));
    });
    expect(surfaces()).toEqual(["review"]);
    mocks.getDraftPreview.mockResolvedValue({
      ...previewOf(),
      draftGeneration: 2,
      reviewRoomName: branchRoomName("review-owner", 2),
    });
    mocks.listWorkDrafts.mockResolvedValue({ drafts: [] });
    await act(async () => {
      answer.resolve(applied(true));
      await done;
    });
    expect(document.querySelector('[data-editor-surface="live"]')).toBeNull();
    expect(review?.controller.inlineReview?.completion?.phase).toBe("closed");
    expect(document.querySelector("[data-review-state]")?.textContent).toBe("Finished");
    await act(async () => transportStatus.get(room)?.({ kind: "unauthorized", reason: "missing" }));
    expect(document.querySelector('[data-editor-surface="live"]')).toBeNull();
    expect(review?.controller.inlineReview?.draftId).toBe(draftA.draftId);
  });
});

it("pending Discard is inert warm live, refusal restores review, and confirmed Apply preserves live Undo", async () => {
  await run(async (_client, room) => {
    const liveNode = document.querySelector<
      HTMLElement & { editor?: import("@tiptap/core").Editor }
    >('[data-editor-surface="live"] .ProseMirror');
    const live = liveNode?.editor;
    if (!live) throw new Error("Missing warm live editor");
    await act(async () => live.commands.insertContent("Warm live edit."));
    const discard = deferredReviewAnswer<ReturnType<typeof discarded>>();
    mocks.discardDraft.mockReturnValue(discard.promise);
    let done: Promise<unknown> | undefined;
    await act(async () => {
      done = review?.controller.discardChanges(draftA, change("2"));
    });
    expect(surfaces()).toEqual(["live"]);
    expect(mounted()).toBe(live);
    expect(live.isEditable).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(16));
    const refusalSync = deferredReviewAnswer<void>();
    const branch = review?.roomOwner.session;
    if (!branch) throw new Error("Missing branch session");
    vi.spyOn(branch, "whenLocalPersistenceSynced").mockReturnValue(refusalSync.promise);
    await act(async () => {
      discard.resolve(discarded(false));
      await done;
    });
    expect(document.querySelector("[data-paint-hold]")?.textContent).toContain("Warm live edit.");
    await act(async () => refusalSync.resolve());
    await settled(() => expect(surfaces()).toEqual(["review"]));
    const apply = deferredReviewAnswer<ReturnType<typeof applied>>();
    mocks.applyDraftChanges.mockReturnValue(apply.promise);
    await act(async () => {
      done = review?.controller.applyChanges(draftA, change("2"));
    });
    expect(surfaces()).toEqual(["review"]);
    mocks.getDraftPreview.mockResolvedValue({
      ...previewOf(),
      draftGeneration: 2,
      reviewRoomName: room,
    });
    await act(async () => {
      apply.resolve(applied(true));
      await done;
    });
    await settled(() => expect(surfaces()).toEqual(["live"]));
    expect(mounted()).toBe(live);
    expect(live.isEditable).toBe(true);
    await act(async () => live.commands.undo());
    expect(live.getText()).not.toContain("Warm live edit.");
  });
});

it("a retired rebuild answer cannot replace a later review", async () => {
  await run(async (client, oldRoom) => {
    const release = deferredReviewAnswer<void>();
    teardowns.set(oldRoom, release);
    const old = review?.roomOwner.session;
    await act(async () =>
      transportStatus.get(oldRoom)?.({
        kind: "reset",
        disposition: "rebuild",
        reason: WS_CLOSE.BRANCH_STALE.reason,
      }),
    );
    expect(review?.roomOwner.session).toBeNull();
    const nextRoom = branchRoomName("later-review", 1);
    mocks.getDraftPreview.mockResolvedValue({
      ...previewOf("9"),
      draftId: "draft-b",
      reviewRoomName: nextRoom,
    });
    const rows = [{ ...listed, draftId: "draft-b" }];
    mocks.listWorkDrafts.mockResolvedValue({ drafts: rows });
    await act(async () => {
      client.setQueryData(projectQueryKeys.workDrafts("project-a", "work-a"), rows);
      review?.controller.enterInlineReview(documentId, "draft-b");
    });
    await settled(() => expect(review?.roomOwner.session?.roomKey).toBe(nextRoom));
    await settled(() => expect(surfaces()).toEqual(["review"]));
    const currentEditor = mounted();
    await act(async () => release.resolve());
    await settled(() => expect(old?.getSnapshot().status).toBe("destroyed"));
    expect(review?.controller.inlineReview?.draftId).toBe("draft-b");
    expect(review?.roomOwner.session?.roomKey).toBe(nextRoom);
    expect(mounted()).toBe(currentEditor);
    expect(review?.roomOwner.inputEligible).toBe(true);
  });
});

it("entering review holds the live frame until review paints", async () => {
  await run(async (_client, room) => {
    await act(async () => mounted().commands.insertContent("Last painted live."));
    const sync = deferredReviewAnswer<void>();
    syncs.set(room, sync);
    await act(async () => review?.controller.enterInlineReview(documentId, draftA.draftId));
    expect(document.querySelector("[data-paint-hold]")?.textContent).toContain(
      "Last painted live.",
    );
    expect(surfaces()).toEqual([]);
    await act(async () => sync.resolve());
    await settled(() => expect(surfaces()).toEqual(["review"]));
    expect(document.querySelector("[data-paint-hold]")).toBeNull();
  }, false);
});

it("a draft-only tab without a review is terminal, not an empty pending editor", async () => {
  draftOnly = true;
  await run(async () => {
    expect(document.body.textContent).toContain("Couldn't open this draft.");
    expect(document.querySelector("[data-paint-hold]")).toBeNull();
    expect(
      [...document.querySelectorAll("button")].some((node) => node.textContent === "Close"),
    ).toBe(true);
  }, false);
});

function ReviewChromeWitness() {
  const { controller } = useDraftReview();
  const view = useReviewChanges(controller);
  usePaintPending(view.status === "loading");
  return (
    <>
      <PaintCapture surface={view.status} />
      <p data-review-state>
        {view.finished
          ? "Finished"
          : view.status === "ready" && !view.items.length
            ? "No listed changes"
            : view.status}
      </p>
    </>
  );
}

it("an incoming proposal holds the painted chrome across the room observation precursor", async () => {
  await run(async (client) => {
    await act(async () => mounted().commands.insertContent("Painted generation one."));
    const room = branchRoomName("review-owner", 2);
    const sync = deferredReviewAnswer<void>();
    syncs.set(room, sync);
    mocks.getDraftPreview.mockResolvedValue({
      ...previewOf("3"),
      draftGeneration: 2,
      reviewRoomName: room,
    });
    mocks.listWorkDrafts.mockResolvedValue({ drafts: [{ ...listed, draftGeneration: 2 }] });
    await act(async () =>
      client.setQueryData(
        projectQueryKeys.workDraftPreview("project-a", "work-a", documentId, draftA.draftId),
        { ...previewOf("3"), draftGeneration: 2, reviewRoomName: room },
      ),
    );
    await settled(() => expect(document.querySelector("[data-paint-hold]")).not.toBeNull());
    expect(document.querySelector("[data-paint-hold]")?.textContent).toContain(
      "Painted generation one.",
    );
    expect(document.querySelector("[data-paint-hold]")?.textContent).not.toContain(
      "No listed changes",
    );
    await act(async () => sync.resolve());
    await settled(() => expect(document.querySelector("[data-paint-hold]")).toBeNull());
    await act(async () =>
      client.setQueryData(
        projectQueryKeys.workDraftPreview("project-a", "work-a", documentId, draftA.draftId),
        { ...previewOf(), draftGeneration: 3, reviewRoomName: room },
      ),
    );
    expect(review?.controller.inlineReview?.draftGeneration).toBe(2);
    expect(document.querySelector("[data-paint-hold]")).toBeNull();
    await settled(() =>
      expect(document.querySelector("[data-review-state]")?.textContent).toBe("No listed changes"),
    );
  });
});

it("schema-stale is terminal before marks or the marks wait", async () => {
  supplyMarks = false;
  await run(async (_client, room) => {
    await act(async () => review?.controller.enterInlineReview(documentId, draftA.draftId));
    await settled(() => expect(review?.roomOwner.session).not.toBeNull());
    expect(surfaces()).toEqual([]);
    await act(async () =>
      transportStatus.get(room)?.({
        kind: "reset",
        disposition: "schema",
        reason: WS_CLOSE.DOCUMENT_SCHEMA_STALE.reason,
      }),
    );
    expect(document.querySelector("[data-document-schema-stale]")?.textContent).toContain(
      "temporarily unavailable",
    );
    expect(document.querySelector("[data-paint-hold]")).toBeNull();
    expect(review?.roomOwner.inputEligible).toBe(false);
  }, false);
});
