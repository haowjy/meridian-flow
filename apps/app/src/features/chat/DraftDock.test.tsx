/**
 * useDraftDock behavior: the disposition lock (busy off isDisposing, not
 * isPending) and the bulk-discard pump draining a captured snapshot even
 * when the work-drafts query stays stale.
 */
import { act, useEffect, useMemo, useRef, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadDraftGroup } from "@/client/query/useWorkDrafts";
import { withReactRoot } from "@/test-support/react-dom-harness";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@lingui/core/macro", () => ({ t: (strings: TemplateStringsArray) => strings[0] }));

function draftGroup(documentId: string, draftId: string): ThreadDraftGroup {
  const contextPath = `work://drafts/${documentId}.md`;
  return {
    documentId,
    documentName: documentId,
    contextPath,
    drafts: [
      {
        draftId,
        documentId,
        documentName: documentId,
        contextPath,
        status: "active",
        lastActorTurnId: null,
        updatedAt: "2026-07-07T00:00:00.000Z",
        appliedAt: null,
        discardedAt: null,
        wordsAdded: null,
        wordsRemoved: null,
      },
    ],
  };
}

type ControllerStub = {
  isPending: boolean;
  isDisposing: boolean;
  accept: ReturnType<typeof vi.fn>;
  reject: ReturnType<typeof vi.fn>;
  needsRereview: boolean;
  applyRefusal: null;
};

const harnessRef: {
  groups: ThreadDraftGroup[];
  dock: { isBusy: boolean; needsRereview: boolean; startDiscardAll: () => void } | null;
  rejectCalls: string[];
  controller: ControllerStub;
} = {
  groups: [],
  dock: null,
  rejectCalls: [],
  controller: {
    isPending: false,
    isDisposing: false,
    accept: vi.fn(),
    reject: vi.fn(),
    needsRereview: false,
    applyRefusal: null,
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
      groups: harnessRef.groups,
      controller: harnessRef.controller,
      nowMs: 1_752_000_000_000,
    }),
  };
});

const { DraftApplyRefusalNotice, useDraftDock } = await import("./DraftDock");

function DockHarness() {
  const dock = useDraftDock({ generating: false });
  useEffect(() => {
    harnessRef.dock = dock;
  });
  return null;
}

/** Reject flips isPending for a tick so the pump has to wait it out per card. */
function PumpHarness() {
  const [isPending, setIsPending] = useState(false);
  const rejectCallsRef = useRef<string[]>([]);
  harnessRef.controller = useMemo(
    () => ({
      isPending,
      isDisposing: isPending,
      accept: vi.fn(),
      reject: vi.fn(async (_documentId: string, draftId: string) => {
        rejectCallsRef.current.push(draftId);
        setIsPending(true);
        await Promise.resolve();
        setIsPending(false);
      }),
      needsRereview: false,
      applyRefusal: null,
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

beforeEach(() => {
  harnessRef.groups = [];
  harnessRef.dock = null;
  harnessRef.rejectCalls = [];
  harnessRef.controller = {
    isPending: false,
    isDisposing: false,
    accept: vi.fn(),
    reject: vi.fn(),
    needsRereview: false,
    applyRefusal: null,
  };
});

describe("DraftDock Apply refusal", () => {
  it("explains draft-base divergence and renders the writer's live words", () => {
    const html = renderToStaticMarkup(
      <DraftApplyRefusalNotice
        refusal={{
          reason: "unsynced_live_edits",
          passages: [{ body: "The writer added this live sentence." }],
        }}
      />,
    );
    expect(html).toContain("your live document changed since this draft was prepared");
    expect(html).toContain("The writer added this live sentence.");
  });

  it("renders protected resurrection refusal copy", () => {
    const html = renderToStaticMarkup(
      <DraftApplyRefusalNotice
        refusal={{ reason: "protected_resurrection", passages: [{ body: "Deleted line." }] }}
      />,
    );
    expect(html).toContain("bring back text you deleted");
    expect(html).toContain("Deleted line.");
  });
});

describe("useDraftDock disposition lock", () => {
  it("marks dock busy while a per-card Apply is in flight (isDisposing, not isPending)", async () => {
    harnessRef.groups = [draftGroup("doc-a", "draft-a")];
    harnessRef.controller.isDisposing = true;

    await withReactRoot(<DockHarness />, () => {
      expect(harnessRef.dock?.isBusy).toBe(true);
    });
  });

  it("switches the dock chip to needs re-review after a concurrent conflict", async () => {
    harnessRef.groups = [draftGroup("doc-a", "draft-a")];
    harnessRef.controller.needsRereview = true;

    await withReactRoot(<DockHarness />, () => {
      expect(harnessRef.dock?.needsRereview).toBe(true);
    });
  });
});

describe("useDraftDock bulk discard pump", () => {
  it("discards every captured pending draft even when the work-drafts query stays stale", async () => {
    harnessRef.groups = [draftGroup("doc-a", "draft-a"), draftGroup("doc-b", "draft-b")];

    await withReactRoot(<PumpHarness />, async () => {
      await act(async () => {
        harnessRef.dock?.startDiscardAll();
      });

      for (let attempt = 0; attempt < 8 && harnessRef.rejectCalls.length < 2; attempt += 1) {
        await flushMicrotasks();
      }

      expect(harnessRef.rejectCalls).toEqual(["draft-a", "draft-b"]);
    });
  });
});
