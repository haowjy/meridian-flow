import { act, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import type { ThreadDraftGroup } from "@/client/query/useWorkDrafts";
import { withReactRoot } from "@/test-support/react-dom-harness";

const invalidateQueriesMock = vi.fn();
const exitReviewMock = vi.fn();

const docUpdateHandlers = new Map<string, Set<() => void>>();

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: invalidateQueriesMock }),
}));
vi.mock("@/client/query/useWorkDrafts", () => ({
  useWorkDrafts: () => ({ groups: [] as ThreadDraftGroup[], status: "empty" }),
}));
vi.mock("@/client/stores", () => ({
  useThreadStore: (selector: (state: { now: number }) => number) => selector({ now: 0 }),
}));
vi.mock("./useDraftReviewController", () => ({
  useDraftReviewController: () => ({
    exitReview: exitReviewMock,
    inlineReview: null,
    reviewRoomName: null,
  }),
}));
vi.mock("@/core/editor/document-session-registry", () => ({
  getDocumentSessionRegistry: () => ({
    get: (documentId: string) => {
      if (!docUpdateHandlers.has(documentId)) {
        docUpdateHandlers.set(documentId, new Set());
      }
      return {
        document: {
          on: (event: string, handler: () => void) => {
            if (event !== "update") return;
            docUpdateHandlers.get(documentId)?.add(handler);
          },
          off: (event: string, handler: () => void) => {
            if (event !== "update") return;
            docUpdateHandlers.get(documentId)?.delete(handler);
          },
        },
      };
    },
    has: (documentId: string) => docUpdateHandlers.has(documentId),
  }),
}));

const { DraftReviewProvider, useDraftReview } = await import("./DraftReviewProvider");

function SetActiveEditorDocument({ documentId }: { documentId: string }) {
  const { setActiveEditorDocumentId } = useDraftReview();
  useEffect(() => {
    setActiveEditorDocumentId(documentId);
  }, [documentId, setActiveEditorDocumentId]);
  return null;
}

function emitDocumentUpdate(documentId: string) {
  for (const handler of docUpdateHandlers.get(documentId) ?? []) {
    handler();
  }
}

async function withProvider(documentId: string, run: () => Promise<void> | void): Promise<void> {
  await withReactRoot(
    <DraftReviewProvider projectId="project-1" workId="work-1" threadId="thread-1">
      <SetActiveEditorDocument documentId={documentId} />
    </DraftReviewProvider>,
    run,
  );
}

describe("DraftReviewProvider live lineage invalidation", () => {
  beforeEach(() => {
    invalidateQueriesMock.mockClear();
    docUpdateHandlers.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces live-lineage invalidation when the mounted editor document updates", async () => {
    await withProvider("doc-live", async () => {
      invalidateQueriesMock.mockClear();
      emitDocumentUpdate("doc-live");
      expect(invalidateQueriesMock).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(200);
      });

      expect(invalidateQueriesMock).toHaveBeenCalledWith({
        queryKey: threadQueryKeys.liveLineageRoot("thread-1"),
      });
    });
  });

  it("uses registry.get so the listener attaches without a prior has() guard", async () => {
    await withProvider("doc-new", async () => {
      invalidateQueriesMock.mockClear();
      emitDocumentUpdate("doc-new");
      await act(async () => {
        vi.advanceTimersByTime(200);
      });

      expect(invalidateQueriesMock).toHaveBeenCalledWith({
        queryKey: threadQueryKeys.liveLineageRoot("thread-1"),
      });
    });
  });
});
