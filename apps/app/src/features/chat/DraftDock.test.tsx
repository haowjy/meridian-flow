/**
 * useDraftDock behavior: the disposition lock (busy off isDisposing, not
 * isPending) and delegation of bulk commands to the review session.
 */
import { act, useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadDraftGroup } from "@/client/query/useWorkDrafts";
import { withReactRoot } from "@/test-support/react-dom-harness";
import type { DraftDockModel } from "./DraftDock";

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
  disposeDrafts: ReturnType<typeof vi.fn>;
  dockDispositionError: "apply-failed" | "discard-offline" | null;
  needsRereview: boolean;
  applyRefusal: null;
};

const harnessRef: {
  groups: ThreadDraftGroup[];
  dock: DraftDockModel | null;
  controller: ControllerStub;
} = {
  groups: [],
  dock: null,
  controller: {
    isPending: false,
    isDisposing: false,
    accept: vi.fn(),
    reject: vi.fn(),
    disposeDrafts: vi.fn(),
    dockDispositionError: null,
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

const { DraftApplyRefusalNotice, DraftDock, useDraftDock } = await import("./DraftDock");

function DockHarness() {
  const dock = useDraftDock({ generating: false });
  useEffect(() => {
    harnessRef.dock = dock;
  });
  return null;
}

function DockViewHarness() {
  const dock = useDraftDock({ generating: false });
  return <DraftDock dock={dock} />;
}

beforeEach(() => {
  harnessRef.groups = [];
  harnessRef.dock = null;
  harnessRef.controller = {
    isPending: false,
    isDisposing: false,
    accept: vi.fn(),
    reject: vi.fn(),
    disposeDrafts: vi.fn(async () => []),
    dockDispositionError: null,
    needsRereview: false,
    applyRefusal: null,
  };
});

describe("DraftDock Apply refusal", () => {
  it.each([
    [
      "unsynced_live_edits",
      "The chapter changed after this draft was written:",
      "The writer added this live sentence.",
    ],
    ["protected_resurrection", "Applying would bring back text you deleted:", "Deleted line."],
    ["stale_draft", "This draft was updated after you opened it.", null],
  ] as const)("uses the uniform headline and discloses the %s reason and passages on click", async (reason, explanation, passage) => {
    await withReactRoot(
      <DraftApplyRefusalNotice
        refusal={{ reason, passages: passage ? [{ body: passage }] : [] }}
      />,
      async () => {
        const notice = document.querySelector(`[data-draft-apply-refusal="${reason}"]`);
        const headline = notice?.querySelector(".font-medium");
        const disclosure = notice?.querySelector("button");

        expect(headline?.textContent).toBe("Not applied");
        expect(notice?.textContent).toBe("Not applied");
        expect(notice?.textContent).not.toContain(explanation);
        expect(notice?.getAttribute("data-draft-apply-refusal-expanded")).toBe("false");
        expect(disclosure?.getAttribute("aria-expanded")).toBe("false");
        expect(notice?.querySelector("[data-draft-apply-refusal-details]")).toBeNull();
        if (passage) expect(notice?.textContent).not.toContain(passage);

        await act(async () => disclosure?.click());

        const details = notice?.querySelector("[data-draft-apply-refusal-details]");
        expect(notice?.textContent).toContain(explanation);
        expect(notice?.getAttribute("data-draft-apply-refusal-expanded")).toBe("true");
        expect(disclosure?.getAttribute("aria-expanded")).toBe("true");
        expect(disclosure?.getAttribute("aria-controls")).toBe(details?.id);
        expect(details?.querySelector("[data-draft-apply-refusal-explanation]")).not.toBeNull();
        if (passage) {
          expect(details?.textContent).toContain(passage);
          expect(details?.textContent?.indexOf(explanation)).toBeLessThan(
            details?.textContent?.indexOf(passage) ?? -1,
          );
        }
      },
    );
  });

  it("keeps neutral dock styling", async () => {
    await withReactRoot(
      <DraftApplyRefusalNotice refusal={{ reason: "stale_draft", passages: [] }} />,
      () => {
        const notice = document.querySelector("[data-draft-apply-refusal]");
        expect(notice?.className).toContain("border-border-subtle");
        expect(notice?.className).toContain("bg-muted");
        expect(notice?.className).toContain("text-prose-foreground");
        expect(notice?.className).not.toContain("warning");
      },
    );
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

describe("useDraftDock bulk disposition", () => {
  it("routes a single dock Apply through current-preview disposition", async () => {
    harnessRef.groups = [draftGroup("doc-a", "draft-a")];

    await withReactRoot(<DockHarness />, async () => {
      const row = harnessRef.dock?.pendingRows[0];
      if (!row) throw new Error("missing pending row");
      await act(async () => {
        await harnessRef.dock?.applyRow(row);
      });

      expect(harnessRef.controller.accept).not.toHaveBeenCalled();
      expect(harnessRef.controller.disposeDrafts).toHaveBeenCalledWith("apply", [
        { documentId: "doc-a", draftId: "draft-a" },
      ]);
    });
  });

  it("hands one captured draft snapshot to the session command", async () => {
    harnessRef.groups = [draftGroup("doc-a", "draft-a"), draftGroup("doc-b", "draft-b")];

    await withReactRoot(<DockHarness />, async () => {
      await act(async () => {
        harnessRef.dock?.startDiscardAll();
      });

      expect(harnessRef.controller.disposeDrafts).toHaveBeenCalledWith("discard", [
        { documentId: "doc-a", draftId: "draft-a" },
        { documentId: "doc-b", draftId: "draft-b" },
      ]);
    });
  });

  it("shows a typed dock disposition failure", async () => {
    harnessRef.groups = [draftGroup("doc-a", "draft-a")];
    harnessRef.controller.dockDispositionError = "apply-failed";

    await withReactRoot(<DockViewHarness />, () => {
      expect(document.body.textContent).toContain(
        "Couldn't apply. Check your connection and try again.",
      );
    });
  });
});
