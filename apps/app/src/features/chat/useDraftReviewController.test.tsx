import { createRequire } from "node:module";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { acceptDraftMock, rejectDraftMock, getDraftPreviewMock, undoAcceptDraftMock } = vi.hoisted(
  () => ({
    acceptDraftMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
      status: "applied",
      draftId: "draft-1",
    })),
    undoAcceptDraftMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
      status: "reactivated",
      draftId: "draft-1",
    })),
    rejectDraftMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
      status: "discarded",
      draftId: "draft-1",
    })),
    getDraftPreviewMock: vi.fn<() => Promise<unknown>>(async () => ({
      status: "active",
      draftId: "draft-1",
      live: "live text",
      preview: "preview text",
      liveRevisionToken: 3,
      draftRevisionToken: 7,
      inlineModelPresent: true,
      operations: [],
      hunks: [],
    })),
  }),
);

vi.mock("@/client/api/drafts-api", () => ({
  getDraftPreview: getDraftPreviewMock,
  acceptDraft: acceptDraftMock,
  rejectDraft: rejectDraftMock,
  undoAcceptDraft: undoAcceptDraftMock,
  undoRejectDraft: vi.fn(async () => ({ status: "reactivated", draftId: "draft-1" })),
}));
vi.mock("@/core/editor/document-session-registry", () => ({
  getDocumentSessionRegistry: () => ({ has: () => false }),
}));
vi.mock("./inline-review-discard-operation", () => ({
  rejectInlineReviewOperation: vi.fn(),
}));
const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as {
  JSDOM: new (
    html: string,
  ) => {
    window: Window & typeof globalThis & { close: () => void };
  };
};

const { useDraftReviewController } = await import("./useDraftReviewController");
type DraftReviewController = ReturnType<typeof useDraftReviewController>;

beforeEach(() => {
  acceptDraftMock.mockClear();
  rejectDraftMock.mockClear();
  getDraftPreviewMock.mockClear();
  undoAcceptDraftMock.mockClear();
  acceptDraftMock.mockResolvedValue({ status: "applied", draftId: "draft-1" });
  undoAcceptDraftMock.mockResolvedValue({ status: "reactivated", draftId: "draft-1" });
});

/** Runs the real hook against a real QueryClient so thread-cache invalidation is observable. */
async function withController(
  threadId: string | null,
  run: (input: {
    controller: () => DraftReviewController;
    invalidatedKeys: () => readonly (readonly unknown[])[];
    flush: () => Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
  try {
    const rootNode = dom.window.document.getElementById("root");
    if (!rootNode) throw new Error("missing root");
    const root = createRoot(rootNode);
    const ref: { current: DraftReviewController | null } = { current: null };
    function Capture() {
      ref.current = useDraftReviewController("project-1", "work-1", threadId);
      return null;
    }
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Capture />
        </QueryClientProvider>,
      );
    });
    await run({
      controller: () => {
        if (!ref.current) throw new Error("controller not mounted");
        return ref.current;
      },
      invalidatedKeys: () =>
        invalidateSpy.mock.calls
          .map(([filters]) => (filters && "queryKey" in filters ? filters.queryKey : null))
          .filter((key): key is readonly unknown[] => Array.isArray(key)),
      flush: async () => {
        // The accept path chains sync-wait → preview fetch → mutation →
        // onSuccess invalidation; a few macrotask turns settle all of it.
        await act(async () => {
          for (let i = 0; i < 5; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
        });
      },
    });
    await act(async () => root.unmount());
  } finally {
    queryClient.clear();
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    dom.window.close();
  }
}

describe("useDraftReviewController thread cache invalidation", () => {
  it("fetches the preview on cold inline-review entry and vends the branch room", async () => {
    getDraftPreviewMock.mockResolvedValueOnce({
      status: "active",
      draftId: "draft-1",
      reviewRoomName: "branch:branch-1:gen:2",
      live: "live text",
      preview: "preview text",
      liveRevisionToken: 3,
      draftRevisionToken: 7,
      inlineModelPresent: true,
      operations: [],
      hunks: [],
    });

    await withController("thread-1", async ({ controller, flush }) => {
      await act(async () => {
        controller().enterInlineReview("doc-1", "draft-1");
      });
      expect(controller().inlineReview).toMatchObject({ documentId: "doc-1", draftId: "draft-1" });

      await flush();

      expect(getDraftPreviewMock).toHaveBeenCalledWith("project-1", "work-1", "doc-1", "draft-1");
      expect(controller().reviewRoomName).toBe("branch:branch-1:gen:2");
    });
  });

  it("drops a stale review room on exit and fetches the new generation on re-entry", async () => {
    getDraftPreviewMock
      .mockResolvedValueOnce({
        status: "active",
        draftId: "draft-1",
        reviewRoomName: "branch:branch-1:gen:2",
        live: "live text",
        preview: "preview text",
        liveRevisionToken: 3,
        draftRevisionToken: 7,
        inlineModelPresent: true,
        operations: [],
        hunks: [],
      })
      .mockResolvedValueOnce({
        status: "active",
        draftId: "draft-1",
        reviewRoomName: "branch:branch-1:gen:3",
        live: "live text",
        preview: "preview text",
        liveRevisionToken: 4,
        draftRevisionToken: 8,
        inlineModelPresent: true,
        operations: [],
        hunks: [],
      });

    await withController("thread-1", async ({ controller, flush }) => {
      await act(async () => controller().enterInlineReview("doc-1", "draft-1"));
      await flush();
      expect(controller().reviewRoomName).toBe("branch:branch-1:gen:2");

      await act(async () => controller().exitInlineReview());
      expect(controller().reviewRoomName).toBeNull();

      await act(async () => controller().enterInlineReview("doc-1", "draft-1"));
      await flush();
      expect(controller().reviewRoomName).toBe("branch:branch-1:gen:3");
    });
  });

  it("does not let a stale preview failure clear a newer review room", async () => {
    let rejectFirst: ((cause?: unknown) => void) | undefined;
    getDraftPreviewMock
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockResolvedValueOnce({
        status: "active",
        draftId: "draft-2",
        reviewRoomName: "branch:branch-2:gen:1",
        live: "live text",
        preview: "preview text",
        liveRevisionToken: 3,
        draftRevisionToken: 7,
        inlineModelPresent: true,
        operations: [],
        hunks: [],
      });

    await withController("thread-1", async ({ controller, flush }) => {
      await act(async () => controller().enterInlineReview("doc-1", "draft-1"));
      await act(async () => controller().enterInlineReview("doc-2", "draft-2"));
      await flush();
      expect(controller().reviewRoomName).toBe("branch:branch-2:gen:1");

      await act(async () => rejectFirst?.(new Error("stale preview failed")));
      await flush();

      expect(controller().inlineReview).toMatchObject({ documentId: "doc-2", draftId: "draft-2" });
      expect(controller().reviewRoomName).toBe("branch:branch-2:gen:1");
    });
  });

  it("keeps an inline review recoverable when preview entry fails", async () => {
    getDraftPreviewMock.mockRejectedValueOnce(new Error("network down")).mockResolvedValueOnce({
      status: "active",
      draftId: "draft-1",
      reviewRoomName: "branch:branch-1:gen:2",
      live: "live text",
      preview: "preview text",
      liveRevisionToken: 3,
      draftRevisionToken: 7,
      inlineModelPresent: true,
      operations: [],
      hunks: [],
    });

    await withController("thread-1", async ({ controller, flush }) => {
      await act(async () => controller().enterInlineReview("doc-1", "draft-1"));
      await flush();

      expect(controller().inlineReview).toMatchObject({ documentId: "doc-1", draftId: "draft-1" });
      expect(controller().reviewRoomName).toBeNull();
      expect(controller().reviewRoomError).toBe(true);

      await act(async () => controller().enterInlineReview("doc-1", "draft-1"));
      await flush();

      expect(controller().reviewRoomName).toBe("branch:branch-1:gen:2");
      expect(controller().reviewRoomError).toBe(false);
    });
  });

  it("ignores an older same-draft entry response after a newer attempt", async () => {
    let resolveFirst: ((value: unknown) => void) | undefined;
    getDraftPreviewMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({
        status: "active",
        draftId: "draft-1",
        reviewRoomName: "branch:branch-1:gen:3",
        live: "live text",
        preview: "preview text",
        liveRevisionToken: 4,
        draftRevisionToken: 8,
        inlineModelPresent: true,
        operations: [],
        hunks: [],
      });

    await withController("thread-1", async ({ controller, flush }) => {
      await act(async () => controller().enterInlineReview("doc-1", "draft-1"));
      await act(async () => controller().enterInlineReview("doc-1", "draft-1"));
      await flush();
      expect(controller().reviewRoomName).toBe("branch:branch-1:gen:3");

      await act(async () =>
        resolveFirst?.({
          status: "active",
          draftId: "draft-1",
          reviewRoomName: "branch:branch-1:gen:2",
          live: "live text",
          preview: "preview text",
          liveRevisionToken: 3,
          draftRevisionToken: 7,
          inlineModelPresent: true,
          operations: [],
          hunks: [],
        }),
      );
      await flush();

      expect(controller().reviewRoomName).toBe("branch:branch-1:gen:3");
    });
  });

  it("threads the focused threadId through whole-draft accept so thread caches refresh", async () => {
    await withController("thread-1", async ({ controller, invalidatedKeys, flush }) => {
      await act(async () => {
        controller().accept("doc-1", "draft-1");
      });
      await flush();

      expect(acceptDraftMock).toHaveBeenCalled();
      expect(invalidatedKeys()).toContainEqual(["threads", "thread-1", "snapshot"]);
      expect(invalidatedKeys()).toContainEqual(["threads", "thread-1", "live-lineage"]);
    });
  });

  it("sends branchId for whole-draft apply from a cold preview cache", async () => {
    getDraftPreviewMock.mockResolvedValueOnce({
      status: "active",
      branchId: "branch-1",
      live: "live text",
      preview: "preview text",
      liveRevisionToken: 3,
      draftRevisionToken: 7,
      inlineModelPresent: true,
      operations: [],
      hunks: [],
    });

    await withController("thread-1", async ({ controller, flush }) => {
      await act(async () => {
        controller().accept("doc-1", "branch-1");
      });
      await flush();

      expect(acceptDraftMock).toHaveBeenCalledTimes(1);
      expect(acceptDraftMock.mock.calls[0]?.[3]).toEqual({
        branchId: "branch-1",
        draftRevisionToken: 7,
      });
    });
  });

  it("threads the focused threadId through whole-draft reject", async () => {
    await withController("thread-1", async ({ controller, invalidatedKeys, flush }) => {
      await act(async () => {
        controller().reject("doc-1", "draft-1");
      });
      await flush();

      expect(rejectDraftMock).toHaveBeenCalled();
      expect(invalidatedKeys()).toContainEqual(["threads", "thread-1", "snapshot"]);
      expect(invalidatedKeys()).toContainEqual(["threads", "thread-1", "live-lineage"]);
    });
  });

  it("skips thread-key invalidation when no thread owns the surface", async () => {
    await withController(null, async ({ controller, invalidatedKeys, flush }) => {
      await act(async () => {
        controller().reject("doc-1", "draft-1");
      });
      await flush();

      expect(invalidatedKeys().some((key) => key[0] === "threads" && key.length > 1)).toBe(false);
    });
  });

  it("does not resubmit accept after terminal cannot_place for the active draft", async () => {
    acceptDraftMock.mockResolvedValueOnce({ status: "cannot_place", draftId: "draft-1" });

    await withController("thread-1", async ({ controller, flush }) => {
      await act(async () => {
        controller().enterInlineReview("doc-1", "draft-1");
      });
      await act(async () => {
        controller().accept("doc-1", "draft-1");
      });
      await flush();

      expect(controller().cannotPlaceDraft).toEqual({
        documentId: "doc-1",
        draftId: "draft-1",
        identity: null,
      });

      await act(async () => {
        controller().accept("doc-1", "draft-1");
      });
      await flush();

      expect(acceptDraftMock).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps apply fenced when the same cannot_place preview identity reappears", async () => {
    acceptDraftMock.mockResolvedValueOnce({ status: "cannot_place", draftId: "draft-1" });

    await withController("thread-1", async ({ controller, flush }) => {
      await act(async () => {
        controller().enterInlineReview("doc-1", "draft-1");
        controller().inlineReviewModelAvailable("draft-1:3:7", "doc-1", "draft-1", []);
      });
      await act(async () => {
        controller().accept("doc-1", "draft-1");
      });
      await flush();
      await act(async () => {
        controller().inlineReviewModelAvailable("draft-1:3:7", "doc-1", "draft-1", []);
        controller().accept("doc-1", "draft-1");
      });
      await flush();

      expect(acceptDraftMock).toHaveBeenCalledTimes(1);
    });
  });

  it("restores apply when a new preview identity replaces terminal cannot_place", async () => {
    acceptDraftMock
      .mockResolvedValueOnce({ status: "cannot_place", draftId: "draft-1" })
      .mockResolvedValueOnce({ status: "applied", draftId: "draft-1" });

    await withController("thread-1", async ({ controller, flush }) => {
      await act(async () => {
        controller().enterInlineReview("doc-1", "draft-1");
        controller().inlineReviewModelAvailable("draft-1:3:7", "doc-1", "draft-1", []);
      });
      await act(async () => {
        controller().accept("doc-1", "draft-1");
      });
      await flush();
      await act(async () => {
        controller().inlineReviewModelAvailable("draft-1:3:8", "doc-1", "draft-1", []);
      });

      expect(controller().cannotPlaceDraft).toBeNull();

      await act(async () => {
        controller().accept("doc-1", "draft-1");
      });
      await flush();

      expect(acceptDraftMock).toHaveBeenCalledTimes(2);
    });
  });

  it("undoes a per-card apply with the writeId from its receipt", async () => {
    acceptDraftMock.mockResolvedValueOnce({
      status: "partial_applied",
      draftId: "draft-1",
      writeId: "w-42",
    });
    const model = {
      liveRevisionToken: 3,
      draftRevisionToken: 7,
      operations: [
        {
          operationId: "op-1",
          rejectSourceUpdateIds: [],
          kind: "agent",
          contribution: "added",
          classification: "addition",
          hunkCount: 1,
        },
      ],
      hunks: [],
    } as Parameters<DraftReviewController["acceptOperation"]>[1];

    await withController("thread-1", async ({ controller, flush }) => {
      await act(async () => {
        controller().enterInlineReview("doc-1", "draft-1");
      });
      await flush();
      await act(async () => {
        controller().acceptOperation("op-1", model);
      });
      await flush();

      expect(controller().inlineReviewMessage).toMatchObject({
        code: "change-applied",
        writeId: "w-42",
      });

      await act(async () => {
        controller().undoAcceptOperation();
      });
      await flush();

      expect(undoAcceptDraftMock).toHaveBeenCalledTimes(1);
      expect(undoAcceptDraftMock.mock.calls[0]?.[3]).toMatchObject({
        draftId: "draft-1",
        writeId: "w-42",
      });
      expect(controller().inlineReviewMessage?.code).toBe("change-restored");
    });
  });
});

describe("useDraftReviewController runtime claim", () => {
  function fakeEditor() {
    return {
      isDestroyed: false,
      commands: {
        setInlineReviewActiveOperation: vi.fn(),
        scrollInlineReviewOperationIntoView: vi.fn(),
      },
    } as unknown as Parameters<DraftReviewController["releaseInlineReviewRuntime"]>[0];
  }

  // The runtime claim carries the full reject context; focus only reads `.editor`.
  function fakeRuntime(editor: ReturnType<typeof fakeEditor>) {
    return {
      editor,
      draftDoc: {} as never,
      projectId: "project-1",
      workId: "work-1",
      documentId: "doc-1",
      draftId: "draft-1",
    } as Parameters<DraftReviewController["registerInlineReviewRuntime"]>[0];
  }

  it("a stale release from a previous editor does not clear the fresh claim (p2267)", async () => {
    await withController(null, async ({ controller }) => {
      const previous = fakeEditor();
      const next = fakeEditor();

      // Review doc switch: the next editor registers before the previous
      // editor's effect cleanup releases.
      controller().registerInlineReviewRuntime(fakeRuntime(previous));
      controller().registerInlineReviewRuntime(fakeRuntime(next));
      controller().releaseInlineReviewRuntime(previous);

      controller().focusReviewOperation("op-1");
      expect(next.commands.setInlineReviewActiveOperation).toHaveBeenCalledWith("op-1");
      expect(next.commands.scrollInlineReviewOperationIntoView).toHaveBeenCalledWith("op-1");
    });
  });

  it("releasing the held claim disconnects focus", async () => {
    await withController(null, async ({ controller }) => {
      const editor = fakeEditor();
      controller().registerInlineReviewRuntime(fakeRuntime(editor));
      controller().releaseInlineReviewRuntime(editor);

      controller().focusReviewOperation("op-1");
      expect(editor.commands.setInlineReviewActiveOperation).not.toHaveBeenCalled();
    });
  });
});
