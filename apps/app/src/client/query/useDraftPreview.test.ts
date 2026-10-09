/**
 * The shared preview query never goes back a generation: a read answered from
 * before a close can land after the next proposal's, and the draft's generation
 * only rises. A read of the same or a later generation replaces the cache as
 * ever.
 */
import type { DraftPreviewResponse } from "@meridian/contracts/drafts";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDraftCommandRecords } from "./draft-command-record";
import { projectQueryKeys } from "./project-query-keys";
import { draftPreviewQueryOptions } from "./useDraftPreview";

const mocks = vi.hoisted(() => ({ getDraftPreview: vi.fn() }));
vi.mock("@/client/api/drafts-api", () => mocks);

const draft = { projectId: "p", workId: "w", documentId: "doc", draftId: "draft" };
const key = projectQueryKeys.workDraftPreview("p", "w", "doc", "draft");

const preview = (draftGeneration: number, operationId?: string): DraftPreviewResponse => ({
  status: "active",
  draftId: "draft",
  draftGeneration,
  reviewRoomName: `room-${draftGeneration}`,
  liveRevisionToken: "live",
  draftRevisionToken: `token-${draftGeneration}-${operationId ?? "none"}`,
  inlineModelPresent: true,
  operations: operationId
    ? [
        {
          operationId,
          closureClassId: `class-${operationId}`,
          kind: "agent",
          contribution: "added",
          classification: "addition",
          hunkCount: 1,
        },
      ]
    : [],
  hunks: [],
});

/** Read the draft's preview fresh, the way the room read does, and return what the cache holds. */
async function read(client: QueryClient, answer: DraftPreviewResponse) {
  mocks.getDraftPreview.mockResolvedValue(answer);
  const returned = await client.fetchQuery({ ...draftPreviewQueryOptions(draft), staleTime: 0 });
  return { returned, cached: client.getQueryData<DraftPreviewResponse>(key) };
}

describe("the preview cache across generations", () => {
  let client: QueryClient;
  beforeEach(() => {
    vi.clearAllMocks();
    resetDraftCommandRecords();
    client = new QueryClient();
  });

  it("keeps a newer generation when a read of an older one lands", async () => {
    await read(client, preview(2, "5"));
    const { returned, cached } = await read(client, preview(1, "2"));
    expect(returned).toMatchObject({ draftGeneration: 1 });
    expect(cached).toMatchObject({ draftGeneration: 2, draftRevisionToken: "token-2-5" });
  });

  it("takes a read of the same generation (the draft's content moved)", async () => {
    await read(client, preview(2, "5"));
    const { cached } = await read(client, preview(2, "6"));
    expect(cached).toMatchObject({ draftGeneration: 2, draftRevisionToken: "token-2-6" });
  });

  it("takes a read of a later generation, whether it lists changes (the next proposal) or not (the reset)", async () => {
    await read(client, preview(1, "2"));
    expect((await read(client, preview(2))).cached).toMatchObject({ draftGeneration: 2 });
    expect((await read(client, preview(3, "7"))).cached).toMatchObject({ draftGeneration: 3 });
  });

  it("takes a draft the server no longer has, which carries no generation", async () => {
    await read(client, preview(2, "5"));
    const { cached } = await read(client, { status: "gone", draftId: "draft" });
    expect(cached).toEqual({ status: "gone", draftId: "draft" });
  });

  it("keeps the reference when a read changed nothing", async () => {
    const first = await read(client, preview(2, "5"));
    const second = await read(client, preview(2, "5"));
    expect(second.cached).toBe(first.cached);
  });
});
