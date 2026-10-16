// @vitest-environment jsdom
/** Real provider, editor paint, session and pool replacement. Only HTTP and the wire are fake. */

import { branchRoomName, WS_CLOSE } from "@meridian/contracts/protocol";
import { QueryClient } from "@tanstack/react-query";
import { act, useEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
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
