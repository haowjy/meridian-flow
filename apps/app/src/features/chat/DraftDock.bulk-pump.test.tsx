import { createRequire } from "node:module";
import { act, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadDraftGroup } from "@/client/query/useWorkDrafts";

const TWO_PENDING_GROUPS: ThreadDraftGroup[] = [
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
  {
    documentId: "doc-b",
    documentName: "docky",
    contextPath: "work://drafts/docky.md",
    drafts: [
      {
        draftId: "draft-b",
        documentId: "doc-b",
        documentName: "docky",
        contextPath: "work://drafts/docky.md",
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
  dock: { startDiscardAll: () => void } | null;
  rejectCalls: string[];
  controller: {
    isPending: boolean;
    accept: ReturnType<typeof vi.fn>;
    reject: ReturnType<typeof vi.fn>;
  };
} = {
  dock: null,
  rejectCalls: [],
  controller: {
    isPending: false,
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
      groups: TWO_PENDING_GROUPS,
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
  const [isPending, setIsPending] = useState(false);
  const rejectCallsRef = useRef<string[]>([]);
  harnessRef.controller = useMemo(
    () => ({
      isPending,
      accept: vi.fn(),
      reject: vi.fn(async (_documentId: string, draftId: string) => {
        rejectCallsRef.current.push(draftId);
        setIsPending(true);
        await Promise.resolve();
        setIsPending(false);
      }),
    }),
    [isPending],
  );
  const dock = useDraftDock({ generating: false });
  useEffect(() => {
    harnessRef.dock = dock;
    harnessRef.rejectCalls = rejectCallsRef.current;
  });
  return null;
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useDraftDock bulk discard pump", () => {
  beforeEach(() => {
    harnessRef.dock = null;
    harnessRef.rejectCalls = [];
    harnessRef.controller = {
      isPending: false,
      accept: vi.fn(),
      reject: vi.fn(),
    };
  });

  it("discards every captured pending draft even when the work-drafts query stays stale", async () => {
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

      await act(async () => {
        harnessRef.dock?.startDiscardAll();
      });

      for (let attempt = 0; attempt < 8 && harnessRef.rejectCalls.length < 2; attempt += 1) {
        await flushMicrotasks();
      }

      expect(harnessRef.rejectCalls).toEqual(["draft-a", "draft-b"]);
    } finally {
      await act(async () => root.unmount());
      globalThis.window = previousWindow;
      globalThis.document = previousDocument;
      dom.window.close();
    }
  });
});
