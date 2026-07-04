import { createRequire } from "node:module";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { acceptDraftMock, rejectDraftMock, getDraftPreviewMock } = vi.hoisted(() => ({
  acceptDraftMock: vi.fn(async () => ({ status: "applied", draftId: "draft-1" })),
  rejectDraftMock: vi.fn(async () => ({ status: "discarded", draftId: "draft-1" })),
  getDraftPreviewMock: vi.fn(async () => ({
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
}));

vi.mock("@/client/api/drafts-api", () => ({
  getDraftPreview: getDraftPreviewMock,
  acceptDraft: acceptDraftMock,
  rejectDraft: rejectDraftMock,
  undoAcceptDraft: vi.fn(async () => ({ status: "reactivated", draftId: "draft-1" })),
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
  acceptDraftMock.mockResolvedValue({ status: "applied", draftId: "draft-1" });
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

      expect(controller().cannotPlaceDraft).toEqual({ documentId: "doc-1", draftId: "draft-1" });

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
});
