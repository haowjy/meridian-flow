import { createRequire } from "node:module";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import type { ThreadDraftGroup } from "@/client/query/useWorkDrafts";

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

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as {
  JSDOM: new (html: string) => { window: Window & typeof globalThis & { close: () => void } };
};

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
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const rootNode = dom.window.document.getElementById("root");
  if (!rootNode) throw new Error("missing root");
  const root = createRoot(rootNode);
  try {
    await act(async () => {
      root.render(
        <DraftReviewProvider projectId="project-1" workId="work-1" threadId="thread-1">
          <SetActiveEditorDocument documentId={documentId} />
        </DraftReviewProvider>,
      );
    });
    await run();
  } finally {
    await act(async () => root.unmount());
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    dom.window.close();
  }
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
