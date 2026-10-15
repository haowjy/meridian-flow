// @vitest-environment jsdom
/** Real provider, editor paint, session and pool replacement. Only HTTP and the wire are fake. */

import { branchRoomName, WS_CLOSE } from "@meridian/contracts/protocol";
import { QueryClient } from "@tanstack/react-query";
import { act, useEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HttpResponseError } from "@/client/api/http-client";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { PaintCapture, PaintHold, usePaintPending } from "@/components/app/PaintHold";
import { BranchRoomPool } from "@/core/editor/branch-room-pool";
import {
  DocumentSession,
  type DocumentSessionConnectionState,
} from "@/core/editor/document-session";
import type { LiveDocumentSessionRegistry } from "@/core/editor/document-session-registry";
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
  ReviewTestProviders,
  work,
} from "@/test-support/draft-review-scope";
import { createEditorSessions } from "@/test-support/editor-sessions";
import { installEditorShell, ReviewEditorHost } from "@/test-support/editor-shell";
import { settleReact, withReactRoot } from "@/test-support/react-dom-harness";

let shell: ReturnType<typeof installEditorShell>;
let sessions: ReturnType<typeof createEditorSessions>;
beforeEach(() => {
  sessions = createEditorSessions();
  shell = installEditorShell(poolRegistry as unknown as LiveDocumentSessionRegistry);
});
afterEach(async () => {
  shell.dispose();
  await sessions.dispose();
});

const mocks = vi.hoisted(() => ({
  listWorkDrafts: vi.fn(),
  getDraftPreview: vi.fn(),
  applyDraftChanges: vi.fn(),
  discardDraft: vi.fn(),
}));

vi.mock("@/client/api/drafts-api", () => mocks);

vi.mock("./useInlineReviewSync", () => ({
  useInlineReviewSync: (options: import("./useInlineReviewSync").UseInlineReviewSyncOptions) => {
    useEffect(() => {
      if (supplyMarks && options.editor)
        options.onInlineModelAvailable?.("preview-1", options.documentId, options.itemKey);
    }, [options.editor, options.documentId, options.itemKey, options.onInlineModelAvailable]);
  },
}));

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

function Scope() {
  const value = useDraftReviewScopeValue({ projectId: "project-a", work });
  return (
    <DraftReviewBoundary value={value}>
      <PaintHold status="Opening review">
        <ReviewChromeWitness />
        <ReviewEditorHost
          documentId={documentId}
          projectId="project-a"
          session={draftOnly ? undefined : sessions.get(documentId)}
          draftOnly={draftOnly}
          observe={(value) => {
            review = value;
          }}
        />
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
  mocks.listWorkDrafts.mockResolvedValue({ items: [listed] });
});

afterEach(() => {
  pool.invalidate();
  vi.useRealTimers();
});

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
    <ReviewTestProviders client={client}>
      <Scope />
    </ReviewTestProviders>,
    async () => {
      if (enter) {
        await act(async () => review?.controller.enterInlineReview(documentId, draftA.itemKey));
        await settleReact(() => expect(surfaces()).toEqual(["review"]));
      } else if (!draftOnly) await settleReact(() => expect(mounted()).toBeTruthy());
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
    const oldEditor = mounted();
    await act(async () => oldEditor.commands.insertContent("The held review."));
    const live = sessions.get(documentId).document;
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
        branchGeneration: 2,
        reviewRoomName: room,
      });
      mocks.listWorkDrafts.mockResolvedValue({ items: [{ ...listed, branchGeneration: 2 }] });
      await act(async () =>
        read.resolve({ ...previewOf("3"), branchGeneration: 2, reviewRoomName: room }),
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
    await settleReact(() => expect(review?.roomOwner.session).not.toBeNull());
    const frozen = document.querySelector<HTMLElement>("[data-paint-hold]");
    expect(frozen?.textContent).toContain("The held review.");
    // The copy can be scrolled but not written in: its prose is inert.
    expect(frozen?.querySelector("[contenteditable=true]")?.closest("[inert]")).toBeTruthy();
    expect(surfaces()).toEqual([]);
    await act(async () => sync.resolve());
    await settleReact(() => expect(surfaces()).toEqual(["review"]));
    expect(document.querySelector("[data-paint-hold]")).toBeNull();
    expect(mounted()).not.toBe(oldEditor);
    expect(review?.roomOwner.inputEligible).toBe(true);
    expect(sessions.get(documentId).document).toBe(live);
  });
});

it("draft-only has no live fallback, including closed completion and terminal failure", async () => {
  draftOnly = true;
  mocks.listWorkDrafts.mockResolvedValue({ items: [{ ...listed, isNew: true }] });
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
      branchGeneration: 2,
      reviewRoomName: branchRoomName("review-owner", 2),
    });
    mocks.listWorkDrafts.mockResolvedValue({ items: [] });
    await act(async () => {
      answer.resolve(applied(true));
      await done;
    });
    expect(document.querySelector('[data-editor-surface="live"]')).toBeNull();
    expect(review?.controller.inlineReview?.completion?.phase).toBe("closed");
    expect(document.querySelector("[data-review-state]")?.textContent).toBe("Finished");
    await act(async () => transportStatus.get(room)?.({ kind: "unauthorized", reason: "missing" }));
    expect(document.querySelector('[data-editor-surface="live"]')).toBeNull();
    expect(review?.controller.inlineReview?.itemKey).toBe(draftA.itemKey);
  });
});

it("pending Discard is inert warm live, refusal restores review, and confirmed Apply preserves live Undo", async () => {
  await run(async (client, room) => {
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
      discard.reject(new HttpResponseError("refused", 500, null));
      await done;
    });
    expect(document.querySelector("[data-paint-hold]")?.textContent).toContain("Warm live edit.");
    await act(async () => refusalSync.resolve());
    await settleReact(() => expect(surfaces()).toEqual(["review"]));
    // The refused Discard left the change in the draft: the writer's view has it again.
    await act(async () =>
      client.setQueryData(
        projectQueryKeys.workDraftPreview("project-a", "work-a", documentId, draftA.itemKey),
        { ...previewOf("2"), reviewRoomName: room },
      ),
    );
    const apply = deferredReviewAnswer<ReturnType<typeof applied>>();
    mocks.applyDraftChanges.mockReturnValue(apply.promise);
    await act(async () => {
      done = review?.controller.applyChanges(draftA, change("2"));
    });
    expect(surfaces()).toEqual(["review"]);
    mocks.getDraftPreview.mockResolvedValue({
      ...previewOf(),
      branchGeneration: 2,
      reviewRoomName: room,
    });
    await act(async () => {
      apply.resolve(applied(true));
      await done;
    });
    await settleReact(() => expect(surfaces()).toEqual(["live"]));
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
      itemKey: "draft-b",
      reviewRoomName: nextRoom,
    });
    const rows = [{ ...listed, itemKey: "draft-b" }];
    mocks.listWorkDrafts.mockResolvedValue({ items: rows });
    await act(async () => {
      client.setQueryData(projectQueryKeys.workDrafts("project-a", "work-a"), rows);
      review?.controller.enterInlineReview(documentId, "draft-b");
    });
    await settleReact(() => expect(review?.roomOwner.session?.roomKey).toBe(nextRoom));
    await settleReact(() => expect(surfaces()).toEqual(["review"]));
    const currentEditor = mounted();
    await act(async () => release.resolve());
    await settleReact(() => expect(old?.getSnapshot().status).toBe("destroyed"));
    expect(review?.controller.inlineReview?.itemKey).toBe("draft-b");
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
    await act(async () => review?.controller.enterInlineReview(documentId, draftA.itemKey));
    expect(document.querySelector("[data-paint-hold]")?.textContent).toContain(
      "Last painted live.",
    );
    expect(surfaces()).toEqual([]);
    await act(async () => sync.resolve());
    await settleReact(() => expect(surfaces()).toEqual(["review"]));
    expect(document.querySelector("[data-paint-hold]")).toBeNull();
  }, false);
});

it("a draft-only tab whose route has no review item yet is pending, never the gone-draft card", async () => {
  draftOnly = true;
  await run(async () => {
    expect(document.body.textContent).not.toContain("Couldn't open");
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
      branchGeneration: 2,
      reviewRoomName: room,
    });
    mocks.listWorkDrafts.mockResolvedValue({ items: [{ ...listed, branchGeneration: 2 }] });
    await act(async () =>
      client.setQueryData(
        projectQueryKeys.workDraftPreview("project-a", "work-a", documentId, draftA.itemKey),
        { ...previewOf("3"), branchGeneration: 2, reviewRoomName: room },
      ),
    );
    await settleReact(() => expect(document.querySelector("[data-paint-hold]")).not.toBeNull());
    expect(document.querySelector("[data-paint-hold]")?.textContent).toContain(
      "Painted generation one.",
    );
    expect(document.querySelector("[data-paint-hold]")?.textContent).not.toContain(
      "No listed changes",
    );
    await act(async () => sync.resolve());
    await settleReact(() => expect(document.querySelector("[data-paint-hold]")).toBeNull());
    await act(async () =>
      client.setQueryData(
        projectQueryKeys.workDraftPreview("project-a", "work-a", documentId, draftA.itemKey),
        { ...previewOf(), branchGeneration: 3, reviewRoomName: room },
      ),
    );
    expect(review?.controller.inlineReview?.branchGeneration).toBe(2);
    expect(document.querySelector("[data-paint-hold]")).toBeNull();
    await settleReact(() =>
      expect(document.querySelector("[data-review-state]")?.textContent).toBe("No listed changes"),
    );
  });
});

it("schema-stale is terminal before marks or the marks wait", async () => {
  supplyMarks = false;
  await run(async (_client, room) => {
    await act(async () => review?.controller.enterInlineReview(documentId, draftA.itemKey));
    await settleReact(() => expect(review?.roomOwner.session).not.toBeNull());
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

it("offers addressed whole Discard when a corrupt draft cannot open", async () => {
  await run(async (_client) => {
    mocks.getDraftPreview.mockResolvedValue({
      status: "corrupt",
      itemKey: draftA.itemKey,
      branchGeneration: 1,
    });
    await act(async () => review?.controller.enterInlineReview(documentId, draftA.itemKey));
    const discardButton = () =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Discard draft",
      );
    await settleReact(() => expect(discardButton()).toBeTruthy());
    const answer = deferredReviewAnswer<ReturnType<typeof discarded>>();
    mocks.discardDraft.mockReturnValue(answer.promise);
    await act(async () => discardButton()?.click());
    expect(mocks.discardDraft).toHaveBeenCalledWith("project-a", "work-a", documentId, {
      commandId: expect.any(String),
      draftId: expect.any(String),
      itemKey: draftA.itemKey,
    });
    expect(discardButton()?.disabled).toBe(true);
    mocks.getDraftPreview.mockResolvedValue({ ...previewOf(), branchGeneration: 2 });
    await act(async () => answer.resolve(discarded(true)));
    await settleReact(() => expect(review?.controller.inlineReview).toBeNull());
    expect(mocks.discardDraft).toHaveBeenCalledTimes(1);
    expect(review?.controller.toast).toBeNull();
  }, false);
});
