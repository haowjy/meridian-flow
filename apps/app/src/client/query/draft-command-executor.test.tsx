// @vitest-environment jsdom
/** Apply is done at server confirmation; a lost response stays unknown; a confirmed draft never returns from an older read. */
import type { ThreadDraftListItem } from "@meridian/contracts/drafts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settleReact, withReactRoot } from "@/test-support/react-dom-harness";
import {
  type DraftCommandOutcome,
  runDraftBatch,
  runDraftSelection,
  runWholeDraftIntent,
  startDraftCommand,
} from "./draft-command-executor";
import {
  bindDraftCommandAccount,
  currentDraftCommandRecords,
  pendingDraftCommand,
  resetDraftCommandRecords,
} from "./draft-command-record";
import { projectQueryKeys } from "./project-query-keys";
import { useWorkDrafts } from "./useWorkDrafts";

const api = vi.hoisted(() => ({
  applyDraft: vi.fn(),
  applyDraftChanges: vi.fn(),
  getDraftPreview: vi.fn(),
  discardDraft: vi.fn(),
  listWorkDrafts: vi.fn(),
}));
vi.mock("@/client/api/drafts-api", () => api);

const input = {
  projectId: "project-a",
  workId: "work-a",
  documentId: "doc-a",
  draftId: "draft-a",
  draftGeneration: 1,
};
const lost = () => new TypeError("Failed to fetch");
const listing = (...draftIds: string[]) => ({
  drafts: draftIds.map((draftId) => ({ draftId, documentId: "doc-a" }) as ThreadDraftListItem),
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type Harness = {
  apply: () => Promise<unknown>;
  listed: () => string[];
  queryClient: QueryClient;
};

async function withHarness(run: (harness: Harness) => Promise<void>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let drafts: string[] = [];
  function Capture() {
    drafts = (useWorkDrafts("project-a", "work-a").drafts ?? []).map((draft) => draft.draftId);
    return null;
  }
  await withReactRoot(
    <QueryClientProvider client={queryClient}>
      <Capture />
    </QueryClientProvider>,
    () =>
      run({
        apply: () =>
          startDraftCommand(queryClient, {
            target: "all",
            draft: input,
            mode: "apply",
            generation: 1,
          }).outcome,
        listed: () => drafts,
        queryClient,
      }),
  );
}

describe("draft command executor", () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetDraftCommandRecords();
    api.listWorkDrafts.mockResolvedValue(listing("draft-a"));
  });

  it("keeps a lost response unknown even when a remote Discard emptied the list", async () => {
    await withHarness(async ({ apply, listed }) => {
      await settleReact(() => expect(listed()).toEqual(["draft-a"]));
      api.applyDraft.mockRejectedValue(lost());
      api.listWorkDrafts.mockResolvedValue(listing());
      await act(async () => expect(await apply()).toEqual({ kind: "apply-outcome-unknown" }));
      await settleReact(() => expect(listed()).toEqual([]));
    });
  });

  it("drops a confirmed draft at once, and no initial read that started earlier brings it back", async () => {
    // No cached list: nothing but the read fence can keep the older read's
    // draft out, since a later refetch would be cancelled by the invalidation.
    api.listWorkDrafts.mockReturnValue(new Promise(() => undefined));
    await withHarness(async ({ apply, listed, queryClient }) => {
      const confirmation = deferred<unknown>();
      api.applyDraft.mockReturnValue(confirmation.promise);
      const older = deferred<ReturnType<typeof listing>>();
      let applied!: Promise<unknown>;
      await act(async () => {
        applied = apply();
      });
      api.listWorkDrafts.mockReturnValueOnce(older.promise);
      await act(async () => {
        void queryClient.refetchQueries({ queryKey: ["projects", "project-a"] });
      });
      await act(async () => {
        confirmation.resolve({ status: "applied", draftId: "draft-a" });
        await applied;
      });
      await act(async () => older.resolve(listing("draft-a")));
      await settleReact(() => expect(listed()).toEqual([]));
    });
  });
});

it("an answer from before an account change cannot settle the new account's claim on the same draft", async () => {
  resetDraftCommandRecords();
  bindDraftCommandAccount("account-a");
  const selection = { classIds: ["c"], operationIds: ["1"] };
  const basis = { liveRevisionToken: "l", draftRevisionToken: "d", draftGeneration: 1 };
  const command = {
    target: "selection" as const,
    draft: input,
    mode: "apply" as const,
    selection,
    basis,
    completesDraft: false,
  };
  const oldAnswer = deferred<unknown>();
  const newAnswer = deferred<unknown>();
  api.applyDraftChanges
    .mockReturnValueOnce(oldAnswer.promise)
    .mockReturnValueOnce(newAnswer.promise);
  const client = new QueryClient();
  const refresh = deferred<void>();
  const reads = vi.spyOn(client, "invalidateQueries").mockImplementation(() => refresh.promise);
  const old = startDraftCommand(client, command).outcome;
  oldAnswer.resolve({
    status: "applied",
    draftId: input.draftId,
    operationIds: ["1"],
    closureClassIds: ["c"],
  });
  await settleReact(() => expect(reads).toHaveBeenCalled());
  bindDraftCommandAccount("account-b");
  bindDraftCommandAccount("account-a");
  const newer = startDraftCommand(client, command).outcome;
  refresh.resolve();
  await expect(old).resolves.toEqual({ kind: "blocked" });
  expect(pendingDraftCommand(currentDraftCommandRecords(), input)).not.toBeNull();
  reads.mockRestore();
  newAnswer.resolve({
    status: "applied",
    draftId: input.draftId,
    operationIds: ["1"],
    closureClassIds: ["c"],
  });
  await newer;
  expect(pendingDraftCommand(currentDraftCommandRecords(), input)).toBeNull();
});

it("a batch sends nothing more once the account has changed", async () => {
  resetDraftCommandRecords();
  bindDraftCommandAccount("account-a");
  const first = deferred<DraftCommandOutcome>();
  const sent: string[] = [];
  const items = ["a", "b"].map((id) => ({
    draft: { documentId: id, draftId: id },
    selection: { classIds: [id], operationIds: [id] },
  }));
  const batch = runDraftBatch(items, (item) => {
    sent.push(item.draft.documentId);
    return first.promise;
  });
  bindDraftCommandAccount("account-b");
  first.resolve({ kind: "blocked" });
  await batch;
  expect(sent).toEqual(["a"]);
});

describe("clicks queued behind a Discard that re-forked the draft", () => {
  const scope = { projectId: input.projectId, workId: input.workId };
  const target = { documentId: input.documentId, draftId: input.draftId };
  // Two independent changes with the very same text: only the part key tells them apart.
  const op = (id: string, partKey: string) => ({
    operationId: id,
    partKey,
    closureClassId: `class-${partKey}`,
    kind: "writer" as const,
    classification: "addition" as const,
    beforeExcerpt: "same",
    afterExcerpt: "same words",
  });
  const preview = (generation: number, ...operations: ReturnType<typeof op>[]) => ({
    status: "active" as const,
    draftId: input.draftId,
    draftGeneration: generation,
    reviewRoomName: "room",
    liveRevisionToken: "live",
    draftRevisionToken: `draft-${generation}`,
    operations,
    hunks: [],
  });
  const selecting = (o: ReturnType<typeof op>) => ({
    classIds: [o.closureClassId],
    operationIds: [o.operationId],
    keys: [o.partKey],
  });
  const discarded = { status: "discarded", draftId: input.draftId, draftClosed: false };
  const seeded = (...operations: ReturnType<typeof op>[]) => {
    resetDraftCommandRecords();
    bindDraftCommandAccount("account-a");
    api.discardDraft.mockReset();
    api.getDraftPreview.mockReset();
    const client = new QueryClient();
    client.setQueryData(
      projectQueryKeys.workDraftPreview(
        input.projectId,
        input.workId,
        input.documentId,
        input.draftId,
      ),
      preview(1, ...operations),
    );
    return client;
  };

  it("sends only the change that was selected, found again by its part key", async () => {
    const [a, b] = [op("2", "edit-a:0"), op("3", "edit-b:0")];
    const client = seeded(a, b);
    api.discardDraft.mockResolvedValue(discarded);
    api.getDraftPreview.mockResolvedValue(preview(2, op("30", "edit-b:0")));
    const first = runDraftSelection(client, scope, "discard", target, selecting(a), null);
    const second = runDraftSelection(client, scope, "discard", target, selecting(b), null);
    await Promise.all([first, second]);
    expect(api.discardDraft).toHaveBeenCalledTimes(2);
    expect(api.discardDraft.mock.calls[0]?.[3]).toMatchObject({ operationIds: ["2"] });
    expect(api.discardDraft.mock.calls[1]?.[3]).toMatchObject({ operationIds: ["30"] });
  });

  it("whole-draft commands share the selective queue and lose their unsent turn on account switch", async () => {
    const a = op("2", "edit-a:0");
    const client = seeded(a);
    const response = deferred<unknown>();
    api.discardDraft.mockReturnValue(response.promise);
    const first = runDraftSelection(client, scope, "discard", target, selecting(a), null);
    const send = vi.fn(() =>
      startDraftCommand(client, {
        target: "all",
        draft: input,
        mode: "apply",
        generation: 1,
      }),
    );
    const next = runWholeDraftIntent(client, input, "apply", send, null);
    expect(next.sent).toBe(false);
    expect(send).not.toHaveBeenCalled();
    bindDraftCommandAccount("account-b");
    expect(await next.outcome).toEqual({ kind: "blocked" });
    response.resolve(discarded);
    await first;
    expect(send).not.toHaveBeenCalled();
  });

  it("sends nothing for a click whose account ended while its draft was being read, and answers every waiter", async () => {
    const [a, b, c] = [op("2", "edit-a:0"), op("3", "edit-b:0"), op("4", "edit-c:0")];
    const client = seeded(a, b, c);
    const read = deferred<ReturnType<typeof preview>>();
    api.discardDraft.mockResolvedValue(discarded);
    api.getDraftPreview.mockReturnValue(read.promise);
    const clicks = [a, b, c].map((o) =>
      runDraftSelection(client, scope, "discard", target, selecting(o), null),
    );
    await settleReact(() => expect(api.getDraftPreview).toHaveBeenCalled());
    bindDraftCommandAccount("account-b");
    bindDraftCommandAccount("account-a");
    read.resolve(preview(2, op("30", "edit-b:0"), op("40", "edit-c:0")));
    const outcomes = await Promise.all(clicks);
    expect(api.discardDraft).toHaveBeenCalledTimes(1);
    expect(outcomes.slice(1)).toEqual([{ kind: "blocked" }, { kind: "blocked" }]);
  });
});
