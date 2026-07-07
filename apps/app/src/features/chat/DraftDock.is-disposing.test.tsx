import { createRequire } from "node:module";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadDraftGroup } from "@/client/query/useWorkDrafts";

const ONE_PENDING_GROUP: ThreadDraftGroup[] = [
  {
    documentId: "doc-a",
    documentName: "dockx",
    contextPath: "work://drafts/dockx.md",
    drafts: [
      {
        draftId: "draft-a",
        documentId: "doc-a",
        documentName: "dockx",
        contextPath: "work://drafts/dockx.md",
        status: "active",
        lastActorTurnId: null,
        updatedAt: "2026-07-07T00:00:00.000Z",
        appliedAt: null,
        discardedAt: null,
        wordsAdded: null,
        wordsRemoved: null,
      },
    ],
  },
];

const harnessRef: {
  dock: { isBusy: boolean } | null;
  controller: {
    isPending: boolean;
    isDisposing: boolean;
    accept: ReturnType<typeof vi.fn>;
    reject: ReturnType<typeof vi.fn>;
  };
} = {
  dock: null,
  controller: {
    isPending: false,
    isDisposing: true,
    accept: vi.fn(),
    reject: vi.fn(),
  },
};

vi.mock("./useAiDraftLauncher", () => ({
  useAiDraftLauncher: () => ({ openAiDraft: vi.fn() }),
}));
vi.mock("./DraftReviewProvider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./DraftReviewProvider")>();
  return {
    ...actual,
    useDraftReview: () => ({
      groups: ONE_PENDING_GROUP,
      controller: harnessRef.controller,
      nowMs: 1_752_000_000_000,
    }),
  };
});

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as {
  JSDOM: new (html: string) => { window: Window & typeof globalThis & { close: () => void } };
};

const { useDraftDock } = await import("./DraftDock");

function PumpHarness() {
  const dock = useDraftDock({ generating: false });
  useEffect(() => {
    harnessRef.dock = dock;
  });
  return null;
}

describe("useDraftDock disposition lock", () => {
  beforeEach(() => {
    harnessRef.dock = null;
    harnessRef.controller = {
      isPending: false,
      isDisposing: true,
      accept: vi.fn(),
      reject: vi.fn(),
    };
  });

  it("marks dock busy while a per-card Apply is in flight (isDisposing, not isPending)", async () => {
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
        root.render(<PumpHarness />);
      });

      expect(harnessRef.dock?.isBusy).toBe(true);
    } finally {
      await act(async () => root.unmount());
      globalThis.window = previousWindow;
      globalThis.document = previousDocument;
      dom.window.close();
    }
  });
});
