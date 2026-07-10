import { act, type ReactNode, useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import type { ThreadDraftGroup } from "@/client/query/useWorkDrafts";
import { withReactRoot } from "@/test-support/react-dom-harness";

const invalidateQueriesMock = vi.fn();
const exitReviewMock = vi.fn();
const resolveDraftOnlyTabMock = vi.fn();
let currentGroups: ThreadDraftGroup[] = [];
let currentInlineReview: { documentId: string; draftId: string } | null = null;
let rerenderProvider: (() => void) | null = null;

const docUpdateHandlers = new Map<string, Set<() => void>>();

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: invalidateQueriesMock }),
}));
vi.mock("@/client/query/useWorkDrafts", () => ({
  useWorkDrafts: () => ({
    groups: currentGroups,
    status: currentGroups.length === 0 ? "empty" : "ready",
  }),
}));
vi.mock("@/client/stores", () => ({
  useThreadStore: (selector: (state: { now: number }) => number) => selector({ now: 0 }),
  useContextTabsStore: {
    getState: () => ({ resolveDraftOnlyTab: resolveDraftOnlyTabMock }),
  },
}));
vi.mock("./useDraftReviewController", () => ({
  useDraftReviewController: () => ({
    exitReview: exitReviewMock,
    inlineReview: currentInlineReview,
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

function ProviderHarness({ children }: { children?: ReactNode }) {
  const [, setRevision] = useState(0);
  useEffect(() => {
    rerenderProvider = () => setRevision((revision) => revision + 1);
    return () => {
      rerenderProvider = null;
    };
  }, []);
  return (
    <DraftReviewProvider projectId="project-1" workId="work-1" threadId="thread-1">
      {children}
    </DraftReviewProvider>
  );
}

function emitDocumentUpdate(documentId: string) {
  for (const handler of docUpdateHandlers.get(documentId) ?? []) {
    handler();
  }
}

async function withProvider(documentId: string, run: () => Promise<void> | void): Promise<void> {
  await withReactRoot(
    <ProviderHarness>
      <SetActiveEditorDocument documentId={documentId} />
    </ProviderHarness>,
    run,
  );
}

describe("DraftReviewProvider live lineage invalidation", () => {
  beforeEach(() => {
    invalidateQueriesMock.mockClear();
    exitReviewMock.mockClear();
    resolveDraftOnlyTabMock.mockClear();
    docUpdateHandlers.clear();
    currentGroups = [];
    currentInlineReview = null;
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

  it("resolves a draft-only tab as discarded when its active draft disappears", async () => {
    currentInlineReview = { documentId: "doc-terminal", draftId: "draft-terminal" };
    currentGroups = [activeGroup()];

    await withReactRoot(<ProviderHarness />, async () => {
      exitReviewMock.mockClear();
      resolveDraftOnlyTabMock.mockClear();
      currentGroups = [];
      await act(async () => rerenderProvider?.());

      expect(resolveDraftOnlyTabMock).toHaveBeenCalledWith(
        "project-1",
        "doc-terminal",
        "discarded",
      );
      expect(exitReviewMock).toHaveBeenCalledTimes(1);
    });
  });
});

function activeGroup(): ThreadDraftGroup {
  return {
    documentId: "doc-terminal",
    documentName: "Terminal",
    contextPath: "/terminal.md",
    drafts: [
      {
        draftId: "draft-terminal",
        documentId: "doc-terminal",
        documentName: "Terminal",
        contextPath: "/terminal.md",
        status: "active",
        lastActorTurnId: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
        appliedAt: null,
        discardedAt: null,
        partialAcceptedOperationCount: 0,
        proposedOperationCount: 1,
        wordsAdded: null,
        wordsRemoved: null,
      },
    ],
  };
}
