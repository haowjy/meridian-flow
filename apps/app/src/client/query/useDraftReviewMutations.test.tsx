// @vitest-environment jsdom
/** Apply resolves at server confirmation; a lost response is told apart from a rejection. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpResponseError } from "@/client/api/http-client";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { DraftApplyOutcomeUnknownError, useApplyDraft } from "./useDraftReviewMutations";

const api = vi.hoisted(() => ({
  applyDraft: vi.fn(),
  discardDraft: vi.fn(),
  listWorkDrafts: vi.fn(),
}));
vi.mock("@/client/api/drafts-api", () => api);

const input = { projectId: "project-a", workId: "work-a", documentId: "doc-a", draftId: "draft-a" };
const lost = () => new TypeError("Failed to fetch");
const listing = (...draftIds: string[]) => ({
  drafts: draftIds.map((draftId) => ({ draftId, documentId: "doc-a" })),
});

async function apply(): Promise<unknown> {
  let apply!: (variables: typeof input) => Promise<unknown>;
  function Capture() {
    apply = useApplyDraft().mutateAsync;
    return null;
  }
  let outcome: unknown;
  await withReactRoot(
    <QueryClientProvider client={new QueryClient()}>
      <Capture />
    </QueryClientProvider>,
    async () => {
      await act(async () => {
        outcome = await apply(input).then(
          () => "applied",
          (error: unknown) => error,
        );
      });
    },
  );
  return outcome;
}

describe("useApplyDraft", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.listWorkDrafts.mockResolvedValue(listing());
  });

  it("is done when the server confirms", async () => {
    api.applyDraft.mockResolvedValue({ status: "applied", draftId: "draft-a" });
    await expect(apply()).resolves.toBe("applied");
    expect(api.listWorkDrafts).not.toHaveBeenCalled();
  });

  it("rejects with the server's answer", async () => {
    const rejection = new HttpResponseError("conflict", 409, null);
    api.applyDraft.mockRejectedValue(rejection);
    await expect(apply()).resolves.toBe(rejection);
    expect(api.listWorkDrafts).not.toHaveBeenCalled();
  });

  it("treats a lost response as applied when the draft has left the list", async () => {
    api.applyDraft.mockRejectedValue(lost());
    api.listWorkDrafts.mockResolvedValue(listing());
    await expect(apply()).resolves.toBe("applied");
  });

  it("treats a lost response as not applied while the draft is still listed", async () => {
    const failure = lost();
    api.applyDraft.mockRejectedValue(failure);
    api.listWorkDrafts.mockResolvedValue(listing("draft-a"));
    await expect(apply()).resolves.toBe(failure);
  });

  it("keeps the outcome unknown when the list cannot be read either", async () => {
    api.applyDraft.mockRejectedValue(lost());
    api.listWorkDrafts.mockRejectedValue(lost());
    await expect(apply()).resolves.toBeInstanceOf(DraftApplyOutcomeUnknownError);
  });
});
