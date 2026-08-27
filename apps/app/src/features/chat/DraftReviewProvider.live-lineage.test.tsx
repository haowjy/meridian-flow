import { act, type ReactNode, useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import type { ThreadDraftGroup } from "@/client/query/useWorkDrafts";
import { withReactRoot } from "@/test-support/react-dom-harness";

const invalidateQueriesMock = vi.fn();
const cancelQueriesMock = vi.fn();
const fetchQueryMock = vi.fn();
const getQueryDataMock = vi.fn();
const queryClientMock = {
  cancelQueries: cancelQueriesMock,
  fetchQuery: fetchQueryMock,
  getQueryData: getQueryDataMock,
  invalidateQueries: invalidateQueriesMock,
};
const resolveDraftOnlyTabMock = vi.fn();
const exitReviewMock = vi.fn();
let currentGroups: ThreadDraftGroup[] = [];
let currentInlineReview: { documentId: string; draftId: string } | null = null;
let currentReviewRoomName: string | null = null;
let currentTabIsDraftOnly = false;
let rerenderProvider: (() => void) | null = null;
let controllerMounts = 0;
let controllerUnmounts = 0;
let queriedWorkIds: Array<string | null> = [];
let controllerWorkIds: string[] = [];

const docUpdateHandlers = new Map<string, Set<() => void>>();

vi.mock("@tanstack/react-query", () => ({
  queryOptions: (options: unknown) => options,
  useQueryClient: () => queryClientMock,
}));
vi.mock("@/client/stores", () => ({
  useContextTabsStore: {
    getState: () => ({
      byProject: {
        "project-1": {
          tabs: currentTabIsDraftOnly
            ? [
                {
                  kind: "tracked",
                  documentId: "doc-terminal",
                  draftOnly: true,
                  reviewWorkId: "work-1",
                },
              ]
            : [],
        },
      },
      resolveDraftOnlyTab: resolveDraftOnlyTabMock,
    }),
  },
}));
vi.mock("@/features/project/context/context-removal-coordinator", () => ({
  contextRemovalCoordinator: {
    resolveDraftApply: (...args: unknown[]) => resolveDraftOnlyTabMock(...args, "committed"),
    executeContextRemoval: (_projectId: string, intent: { documentIds: string[] }) => {
      resolveDraftOnlyTabMock(_projectId, "work-1", intent.documentIds[0], "discarded");
      return Promise.resolve({ kind: "noop" });
    },
  },
}));
vi.mock("@/client/query/useWorkDrafts", () => ({
  useWorkDrafts: (_projectId: string | null, workId: string | null) => {
    queriedWorkIds.push(workId);
    return {
      groups: currentGroups,
      status: currentGroups.length === 0 ? "empty" : "ready",
    };
  },
}));
vi.mock("./useDraftReviewController", () => ({
  useDraftReviewController: (_projectId: string, workId: string) => {
    controllerWorkIds.push(workId);
    useEffect(() => {
      controllerMounts += 1;
      return () => {
        controllerUnmounts += 1;
      };
    }, []);
    return {
      workId,
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

const { DraftReviewBoundary, DraftReviewProvider, useDraftReview, useDraftReviewScopeValue } =
  await import("./DraftReviewProvider");

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

function SiblingScopeHarness() {
  const chat = useDraftReviewScopeValue({
    projectId: "project-1",
    workId: "work-chat-b",
    threadId: "thread-b",
  });
  const editor = useDraftReviewScopeValue({
    projectId: "project-1",
    workId: "work-editor-a",
    threadId: null,
  });
  return (
    <>
      <DraftReviewBoundary value={chat}>{null}</DraftReviewBoundary>
      <DraftReviewBoundary value={editor}>{null}</DraftReviewBoundary>
    </>
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
    cancelQueriesMock.mockReset();
    cancelQueriesMock.mockResolvedValue(undefined);
    fetchQueryMock.mockReset();
    getQueryDataMock.mockReset();
    resolveDraftOnlyTabMock.mockClear();
    exitReviewMock.mockClear();
    docUpdateHandlers.clear();
    currentGroups = [];
    currentInlineReview = null;
    currentReviewRoomName = null;
    currentTabIsDraftOnly = false;
    controllerMounts = 0;
    controllerUnmounts = 0;
    queriedWorkIds = [];
    controllerWorkIds = [];
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

  it("owns isolated Chat B and Editor A queries and controllers", async () => {
    await withReactRoot(<SiblingScopeHarness />, async () => {
      expect(queriedWorkIds).toContain("work-chat-b");
      expect(queriedWorkIds).toContain("work-editor-a");
      expect(controllerWorkIds).toContain("work-chat-b");
      expect(controllerWorkIds).toContain("work-editor-a");
      expect(controllerMounts).toBe(2);
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

  it("exits review when the active draft vanishes", async () => {
    currentInlineReview = { documentId: "doc-terminal", draftId: "draft-terminal" };
    currentGroups = [activeGroup()];

    await withReactRoot(<ProviderHarness />, async () => {
      exitReviewMock.mockClear();
      currentGroups = [];
      await act(async () => rerenderProvider?.());

      expect(exitReviewMock).toHaveBeenCalledTimes(1);
    });
  });

  it("commits a draft-only tab when a remotely accepted draft vanishes", async () => {
    currentInlineReview = { documentId: "doc-terminal", draftId: "draft-terminal" };
    currentGroups = [activeGroup()];
    currentTabIsDraftOnly = true;
    getQueryDataMock.mockReturnValue([]);
    fetchQueryMock.mockResolvedValue(contextTreeResponse(true));

    await withReactRoot(<ProviderHarness />, async () => {
      currentGroups = [];
      await act(async () => rerenderProvider?.());

      expect(resolveDraftOnlyTabMock).toHaveBeenCalledWith(
        "project-1",
        "work-1",
        "doc-terminal",
        "committed",
      );
    });
  });

  it("discards a draft-only tab when a remotely rejected draft vanishes", async () => {
    currentInlineReview = { documentId: "doc-terminal", draftId: "draft-terminal" };
    currentGroups = [activeGroup()];
    currentTabIsDraftOnly = true;
    getQueryDataMock.mockReturnValue([]);
    fetchQueryMock.mockResolvedValue(contextTreeResponse(false));

    await withReactRoot(<ProviderHarness />, async () => {
      currentGroups = [];
      await act(async () => rerenderProvider?.());

      expect(resolveDraftOnlyTabMock).toHaveBeenCalledWith(
        "project-1",
        "work-1",
        "doc-terminal",
        "discarded",
      );
    });
  });

  it("keeps a draft-only tab when remote membership cannot be verified", async () => {
    currentInlineReview = { documentId: "doc-terminal", draftId: "draft-terminal" };
    currentGroups = [activeGroup()];
    currentTabIsDraftOnly = true;
    getQueryDataMock.mockReturnValue([]);
    fetchQueryMock.mockRejectedValue(new Error("offline"));

    await withReactRoot(<ProviderHarness />, async () => {
      currentGroups = [];
      await act(async () => rerenderProvider?.());

      expect(resolveDraftOnlyTabMock).not.toHaveBeenCalled();
    });
  });

  it("keeps a draft-only tab when a replacement active draft appears during reconciliation", async () => {
    currentInlineReview = { documentId: "doc-terminal", draftId: "draft-terminal" };
    currentGroups = [activeGroup()];
    currentTabIsDraftOnly = true;
    getQueryDataMock.mockReturnValue(activeGroup().drafts);
    fetchQueryMock.mockResolvedValue(contextTreeResponse(false));

    await withReactRoot(<ProviderHarness />, async () => {
      currentGroups = [];
      await act(async () => rerenderProvider?.());

      expect(resolveDraftOnlyTabMock).not.toHaveBeenCalled();
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

  it("retargets the review session without remounting chat children", async () => {
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
      expect(controllerUnmounts).toBe(0);
      expect(controllerMounts).toBe(1);
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
        proposedOperationCount: 1,
        wordsAdded: null,
        wordsRemoved: null,
      },
    ],
  };
}

function contextTreeResponse(materialized: boolean) {
  return {
    projectId: "project-1",
    scheme: "manuscript",
    tree: {
      kind: "dir",
      name: "Manuscript",
      path: "/",
      uri: "manuscript://",
      children: materialized
        ? [
            {
              kind: "file",
              documentId: "doc-terminal",
              name: "terminal.md",
              path: "/terminal.md",
              uri: "manuscript://terminal.md",
              provisionalName: false,
              editable: true,
              filetype: "markdown",
              schemaType: "prosemirror",
            },
          ]
        : [],
    },
  };
}
