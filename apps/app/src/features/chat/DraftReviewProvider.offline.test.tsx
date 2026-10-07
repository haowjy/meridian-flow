// @vitest-environment jsdom
/**
 * A writer's Apply or Discard while the browser is offline is refused where they
 * did it, at once: nothing is queued to fire when the network returns. Real
 * provider, controller, mutations and query cache; the network is the only fake.
 */

import { onlineManager } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import {
  applied,
  change,
  discarded,
  listed,
  preview,
  renderReviewScopes,
  type ScopeProbe,
} from "@/test-support/draft-review-scope";

const mocks = vi.hoisted(() => ({
  listWorkDrafts: vi.fn(),
  getDraftPreview: vi.fn(),
  applyDraft: vi.fn(),
  applyDraftChanges: vi.fn(),
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

const classIds = (probe: ScopeProbe) => probe.header.view.items.map((item) => item.change.classId);
const failureOf = (probe: ScopeProbe, classId: string) =>
  probe.header.view.items.find((item) => item.change.classId === classId)?.failure;

async function reviewOpened(probe: () => ScopeProbe) {
  await vi.waitFor(() => expect(mocks.listWorkDrafts).toHaveBeenCalled());
  await act(async () => probe().editor.controller.enterInlineReview("document-a", "draft-a"));
  await vi.waitFor(() => expect(probe().header.view.status).toBe("ready"));
}

/** Go back online and let anything that had been queued run. */
async function reconnect() {
  await act(async () => {
    onlineManager.setOnline(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

describe("a command sent while the browser is offline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDraftCommandRecords();
    mocks.listWorkDrafts.mockResolvedValue({ drafts: [listed] });
    mocks.getDraftPreview.mockResolvedValue(preview);
    mocks.applyDraft.mockResolvedValue({ status: "applied" });
    mocks.applyDraftChanges.mockResolvedValue(applied(false));
    mocks.discardDraft.mockResolvedValue(discarded(false));
  });
  afterEach(() => onlineManager.setOnline(true));

  it("brings an Apply of one change back, refused, and sends nothing when the network returns", async () => {
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      onlineManager.setOnline(false);
      let outcome: unknown;
      await act(async () => {
        outcome = await probe().editor.controller.applyChange(change("2"));
      });
      expect(outcome).toEqual({ kind: "change-refused", mode: "apply", code: "offline" });
      expect(classIds(probe())).toEqual(["class-1", "class-2"]);
      expect(failureOf(probe(), "class-2")).toMatchObject({ code: "offline", mode: "apply" });

      await reconnect();
      expect(mocks.applyDraftChanges).not.toHaveBeenCalled();
    });
  });

  it("brings a Discard of one change back, refused, and sends nothing when the network returns", async () => {
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      onlineManager.setOnline(false);
      let outcome: unknown;
      await act(async () => {
        outcome = await probe().editor.controller.discardChange(change("2"));
      });
      expect(outcome).toEqual({ kind: "change-refused", mode: "discard", code: "offline" });
      expect(failureOf(probe(), "class-2")).toMatchObject({ code: "offline", mode: "discard" });

      await reconnect();
      expect(mocks.discardDraft).not.toHaveBeenCalled();
    });
  });

  it("refuses a whole-draft Apply on the draft instead of holding it until the network returns", async () => {
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      onlineManager.setOnline(false);
      let outcome: unknown;
      await act(async () => {
        outcome = await probe().editor.controller.apply("document-a", "draft-a");
      });
      expect(outcome).toEqual({ kind: "failed", code: "apply-failed" });
      expect(probe().header.commandError).toBe("apply-failed");
      expect(probe().header.locked).toBe(false);

      await reconnect();
      expect(mocks.applyDraft).not.toHaveBeenCalled();
    });
  });

  it("refuses a whole-draft Discard the same way", async () => {
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      onlineManager.setOnline(false);
      let outcome: unknown;
      await act(async () => {
        outcome = await probe().editor.controller.discard("document-a", "draft-a");
      });
      expect(outcome).toEqual({ kind: "failed", code: "discard-offline" });

      await reconnect();
      expect(mocks.discardDraft).not.toHaveBeenCalled();
    });
  });
});
