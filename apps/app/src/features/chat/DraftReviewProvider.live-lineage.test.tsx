import { act, type ReactNode, useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import type { ThreadDraftGroup } from "@/client/query/useWorkDrafts";
import { withReactRoot } from "@/test-support/react-dom-harness";

const invalidateQueriesMock = vi.fn();
const queryClientMock = { invalidateQueries: invalidateQueriesMock };
const exitReviewMock = vi.fn();
const resolveDraftOnlyTabMock = vi.fn();
let currentGroups: ThreadDraftGroup[] = [];
let currentInlineReview: { documentId: string; draftId: string } | null = null;
let currentReviewRoomName: string | null = null;
let rerenderProvider: (() => void) | null = null;
let controllerMounts = 0;
let controllerUnmounts = 0;

const docUpdateHandlers = new Map<string, Set<() => void>>();

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => queryClientMock,
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
  useDraftReviewController: () => {
    useEffect(() => {
      controllerMounts += 1;
      return () => {
        controllerUnmounts += 1;
      };
    }, []);
    return {
      exitReview: exitReviewMock,
      inlineReview: currentInlineReview,
      reviewRoomName: currentReviewRoomName,
    };
  },
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
    getRoom: (roomName: string) => ({
      document: {
        on: (event: string, handler: () => void) => {
          if (event !== "update") return;
          docUpdateHandlers.get(roomName)?.add(handler);
        },
        off: (event: string, handler: () => void) => {
          if (event !== "update") return;
          docUpdateHandlers.get(roomName)?.delete(handler);
        },
      },
    }),
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
    currentReviewRoomName = null;
    controllerMounts = 0;
    controllerUnmounts = 0;
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

  it("attaches the draft-room observer when its room name arrives after selection", async () => {
    currentInlineReview = { documentId: "doc-terminal", draftId: "draft-terminal" };
    currentGroups = [activeGroup()];
    docUpdateHandlers.set("branch:draft-terminal", new Set());

    await withReactRoot(<ProviderHarness />, async () => {
      currentReviewRoomName = "branch:draft-terminal";
      await act(async () => rerenderProvider?.());
      invalidateQueriesMock.mockClear();

      emitDocumentUpdate("branch:draft-terminal");
      await act(async () => {
        vi.advanceTimersByTime(50);
      });

      expect(invalidateQueriesMock).toHaveBeenCalledWith({
        queryKey: projectQueryKeys.workDraftPreview(
          "project-1",
          "work-1",
          "doc-terminal",
          "draft-terminal",
        ),
      });
    });
  });

  it("remounts the review session when the Work identity changes", async () => {
    let switchWork: (() => void) | null = null;

    function ScopedHarness() {
      const [workId, setWorkId] = useState("work-1");
      switchWork = () => setWorkId("work-2");
      return (
        <DraftReviewProvider projectId="project-1" workId={workId} threadId="thread-1">
          <div />
        </DraftReviewProvider>
      );
    }

    await withReactRoot(<ScopedHarness />, async () => {
      expect(controllerMounts).toBe(1);
      await act(async () => switchWork?.());
      expect(controllerUnmounts).toBe(1);
      expect(controllerMounts).toBe(2);
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
