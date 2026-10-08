// @vitest-environment jsdom
/**
 * A whole-draft Apply the server refused is reported where the writer is, not
 * only on the draft's row in a closed menu: Apply draft moves on to the next
 * draft at once, and Apply all keeps going past a draft that fails and says
 * which ones did not apply. Real provider, controller, mutations and query cache;
 * the network is the only fake.
 */

import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpResponseError } from "@/client/api/http-client";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import {
  listed,
  preview,
  renderReviewScopes,
  type ScopeProbe,
} from "@/test-support/draft-review-scope";
import { dockRows } from "./docked-drafts";

const mocks = vi.hoisted(() => ({
  listWorkDrafts: vi.fn(),
  getDraftPreview: vi.fn(),
  applyDraft: vi.fn(),
  discardDraft: vi.fn(),
}));

vi.mock("@/client/api/drafts-api", () => mocks);
vi.mock("@/client/query/useContextCatalog", () => ({
  contextCatalogScope: () => ({ kind: "project", projectId: "project-a" }),
  useContextCatalogView: () => ({ catalog: null }),
  projectCatalogView: () => ({ findDocument: () => null }),
}));
vi.mock("@/features/project/context/account-feature-context", () => ({
  useContextRemovalCoordinator: () => ({ promoteAppliedDraft: vi.fn(), discardDraft: vi.fn() }),
  useOptionalAccountResourceReplica: () => null,
  useLiveDocumentSessionRegistry: () => ({
    retainBranchRooms: vi.fn(),
    releaseBranchRooms: vi.fn(),
    getBranchRoom: () => ({ document: { on: vi.fn(), off: vi.fn() } }),
  }),
}));

const draftOf = (name: string) => ({
  ...listed,
  documentId: `document-${name}`,
  draftId: `draft-${name}`,
  documentName: `Chapter ${name}`,
});
const ref = (name: string) => ({ documentId: `document-${name}`, draftId: `draft-${name}` });

/** Documents whose Apply the server refuses with a 500. */
let refused = new Set<string>();

beforeEach(() => {
  vi.clearAllMocks();
  resetDraftCommandRecords();
  refused = new Set();
  mocks.listWorkDrafts.mockResolvedValue({ drafts: [draftOf("a"), draftOf("b"), draftOf("c")] });
  mocks.getDraftPreview.mockResolvedValue(preview);
  mocks.applyDraft.mockImplementation(async (_project, _work, documentId: string) => {
    if (refused.has(documentId)) throw new HttpResponseError("injected", 500, null);
    return { status: "applied" };
  });
});

const elsewhere = (probe: ScopeProbe) =>
  probe.header.failedElsewhere.map((entry) => [entry.row.documentName, entry.failure.code]);

/** Apply all, as the Changes list sends it: every draft of the Work, in the file order. */
const applyAll = (probe: ScopeProbe) => {
  void probe.editor.controller.disposeDrafts(
    "apply",
    dockRows(probe.editor.groups).map((row) => ({
      documentId: row.documentId,
      draftId: row.draft.draftId,
    })),
  );
};

async function ready(probe: () => ScopeProbe) {
  await vi.waitFor(() => expect(probe().editor.groups).toHaveLength(3));
}

describe("a whole-draft Apply the server refused", () => {
  it("is reported by the next draft's review, which the writer was moved to, and stays on its own draft when opened", async () => {
    refused.add("document-a");
    await renderReviewScopes(
      async (probe) => {
        await ready(probe);
        await act(async () => probe().editor.controller.enterInlineReview("document-a", "draft-a"));
        await act(async () => probe().header.applyDraft());
        await vi.waitFor(() =>
          expect(probe().header.commandError).toEqual({ code: "apply-server-error" }),
        );

        // The writer is now in the next draft; the refusal is reported there.
        await probe().openDraft(ref("b"));
        expect(probe().header.commandError).toBeNull();
        expect(elsewhere(probe())).toEqual([["Chapter a", "apply-server-error"]]);

        // Opening the refused draft is the writer's own move. The refusal is that draft's own
        // message now, and stays on it until they act on it again.
        await act(async () => probe().editor.controller.enterInlineReview("document-a", "draft-a"));
        await probe().openDraft(ref("a"));
        expect(probe().header.commandError).toEqual({ code: "apply-server-error" });
        expect(elsewhere(probe())).toEqual([]);
      },
      { reviewed: ref("a") },
    );
  });
});

describe("Apply all", () => {
  it("applies what it can and reports each draft that did not apply", async () => {
    refused.add("document-a");
    refused.add("document-c");
    await renderReviewScopes(
      async (probe) => {
        await ready(probe);
        await act(async () => {
          await probe().editor.controller.disposeDrafts("apply", [ref("a"), ref("b"), ref("c")]);
        });
        const applied = mocks.applyDraft.mock.calls.map((call) => call[2]);
        expect(applied).toEqual(["document-a", "document-b", "document-c"]);
        await vi.waitFor(() =>
          expect(elsewhere(probe())).toEqual([
            ["Chapter a", "apply-server-error"],
            ["Chapter c", "apply-server-error"],
          ]),
        );
        expect(probe().editor.controller.dockDispositionError).toEqual({
          code: "apply-server-error",
        });
      },
      { reviewed: ref("b") },
    );
  });

  it("does not move the writer when a draft refuses, and says which one in the review they are in", async () => {
    refused.add("document-a");
    refused.add("document-c");
    const onOpenDraft = vi.fn();
    await renderReviewScopes(
      async (probe) => {
        await ready(probe);
        await act(async () => applyAll(probe()));
        await vi.waitFor(() =>
          expect(elsewhere(probe())).toEqual([
            ["Chapter a", "apply-server-error"],
            ["Chapter c", "apply-server-error"],
          ]),
        );
        // Open is the only way to a refused draft.
        expect(onOpenDraft).not.toHaveBeenCalled();
      },
      { reviewed: ref("b"), onOpenDraft },
    );
  });

  it("does not take the writer back to a draft whose refusal arrives after they moved on", async () => {
    let rejectApply!: (error: unknown) => void;
    mocks.applyDraft.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectApply = reject;
        }),
    );
    const onOpenDraft = vi.fn();
    await renderReviewScopes(
      async (probe) => {
        await ready(probe);
        await act(async () => applyAll(probe()));
        await vi.waitFor(() => expect(rejectApply).toBeTypeOf("function"));
        await probe().openDraft(ref("c"));
        await act(async () => probe().editor.controller.enterInlineReview("document-c", "draft-c"));
        await act(async () => rejectApply(new HttpResponseError("injected", 500, null)));
        await vi.waitFor(() =>
          expect(probe().editor.controller.dockDispositionError).toEqual({
            code: "apply-server-error",
          }),
        );
        expect(onOpenDraft).not.toHaveBeenCalled();
        expect(elsewhere(probe())).toEqual([["Chapter a", "apply-server-error"]]);
      },
      { reviewed: ref("b"), onOpenDraft },
    );
  });

  it("keeps the review of the draft it applied open on the batch's pending and settled outcome", async () => {
    refused.add("document-c");
    let finishA!: () => void;
    mocks.applyDraft.mockImplementation(async (_project, _work, documentId: string) => {
      if (documentId === "document-a") await new Promise<void>((resolve) => (finishA = resolve));
      if (refused.has(documentId)) throw new HttpResponseError("injected", 500, null);
      return { status: "applied" };
    });
    await renderReviewScopes(
      async (probe) => {
        await ready(probe);
        await act(async () => probe().editor.controller.enterInlineReview("document-b", "draft-b"));
        await act(async () => applyAll(probe()));
        await vi.waitFor(() => expect(finishA).toBeTypeOf("function"));
        // Another draft is still being sent. The review says so, and is held on it: every
        // "the draft left the list" exit reads a pending completion as the writer's own.
        expect(probe().header.completing).toBe("apply");
        expect(probe().editor.controller.inlineReview?.completion).toMatchObject({
          phase: "pending",
          mode: "apply",
        });

        await act(async () => finishA());
        await vi.waitFor(() =>
          expect(elsewhere(probe())).toEqual([["Chapter c", "apply-server-error"]]),
        );
        // The draft they were in is applied; its review holds on the outcome instead of falling to live.
        expect(probe().editor.controller.inlineReview).toMatchObject({
          draftId: "draft-b",
          completion: { phase: "closed" },
        });
        expect(probe().header.finished).toBe(true);
        expect(probe().header.completing).toBeNull();
      },
      { reviewed: ref("b") },
    );
  });

  it("carries a review on when its own draft is the one that did not apply", async () => {
    refused.add("document-b");
    await renderReviewScopes(
      async (probe) => {
        await ready(probe);
        await act(async () => probe().editor.controller.enterInlineReview("document-b", "draft-b"));
        await act(async () => applyAll(probe()));
        await vi.waitFor(() =>
          expect(probe().header.commandError).toEqual({ code: "apply-server-error" }),
        );
        expect(probe().editor.controller.inlineReview?.completion).toBeUndefined();
        expect(probe().header.finished).toBe(false);
        expect(probe().header.completing).toBeNull();
      },
      { reviewed: ref("b") },
    );
  });

  it("stays in the draft that did not apply, which says so itself", async () => {
    refused.add("document-a");
    const onOpenDraft = vi.fn();
    await renderReviewScopes(
      async (probe) => {
        await ready(probe);
        await act(async () => applyAll(probe()));
        await vi.waitFor(() =>
          expect(probe().header.commandError).toEqual({ code: "apply-server-error" }),
        );
        expect(onOpenDraft).not.toHaveBeenCalled();
      },
      { reviewed: ref("a"), onOpenDraft },
    );
  });

  it("reports every draft when the browser is offline, and sends none", async () => {
    const { onlineManager } = await import("@tanstack/react-query");
    await renderReviewScopes(
      async (probe) => {
        await ready(probe);
        onlineManager.setOnline(false);
        try {
          await act(async () => {
            await probe().editor.controller.disposeDrafts("apply", [ref("a"), ref("b"), ref("c")]);
          });
        } finally {
          onlineManager.setOnline(true);
        }
        expect(mocks.applyDraft).not.toHaveBeenCalled();
        expect(elsewhere(probe())).toEqual([
          ["Chapter a", "apply-offline"],
          ["Chapter c", "apply-offline"],
        ]);
      },
      { reviewed: ref("b") },
    );
  });
});
