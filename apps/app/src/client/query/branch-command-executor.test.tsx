// @vitest-environment jsdom
/** Apply is done at server confirmation; a lost response stays unknown; a confirmed draft never returns from an older read. */
import type { ThreadDraftListItem } from "@meridian/contracts/branches";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpResponseError } from "@/client/api/http-client";
import { ThreadStoreProvider } from "@/client/stores";
import { listed } from "@/test-support/draft-review-scope";
import { settleReact, withReactRoot } from "@/test-support/react-dom-harness";
import {
  runDraftBatch,
  runDraftSelection,
  runWholeDraftIntent,
  runWorkWideCommand,
  startBranchCommand,
} from "./branch-command-executor";
import {
  bindBranchCommandAccount,
  currentBranchCommandRecords,
  currentChangeCommandRecords,
  intentKeys,
  pendingBranchCommand,
  resetBranchCommandRecords,
} from "./branch-command-record";
import { projectQueryKeys } from "./project-query-keys";
import { threadQueryKeys } from "./thread-query-keys";
import { useWorkBranches } from "./useWorkBranches";

const api = vi.hoisted(() => ({
  applyDraft: vi.fn(),
  applyDraftChanges: vi.fn(),
  getDraftPreview: vi.fn(),
  discardDraft: vi.fn(),
  listWorkBranches: vi.fn(),
  applyAllBranches: vi.fn(),
  discardAllBranches: vi.fn(),
  observeBranchCommand: vi.fn(),
}));
vi.mock("@/client/api/branches-api", () => api);

const input = {
  projectId: "project-a",
  workId: "work-a",
  documentId: "doc-a",
  itemKey: "draft-a",
  draftGeneration: 1,
};
const lost = () => new TypeError("Failed to fetch");
const listing = (...itemKeys: string[]) => ({
  items: itemKeys.map(
    (itemKey) =>
      ({
        ...listed,
        itemKey,
        documentId: "doc-a",
        draftGeneration: 1,
      }) satisfies ThreadDraftListItem,
  ),
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
  queryClient.setQueryData(
    projectQueryKeys.workBranches(input.projectId, input.workId),
    listing(input.itemKey).items,
  );
  let branches: string[] = [];
  function Capture() {
    branches = (useWorkBranches("project-a", "work-a").data ?? []).map((draft) => draft.itemKey);
    return null;
  }
  await withReactRoot(
    <QueryClientProvider client={queryClient}>
      <ThreadStoreProvider now={0}>
        <Capture />
      </ThreadStoreProvider>
    </QueryClientProvider>,
    () =>
      run({
        apply: () =>
          startBranchCommand(queryClient, {
            target: "all",
            draft: input,
            mode: "apply",
            generation: 1,
          }).outcome,
        listed: () => branches,
        queryClient,
      }),
  );
}

describe("draft command executor", () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetBranchCommandRecords();
    api.listWorkBranches.mockResolvedValue(listing("draft-a"));
  });

  it("refreshes document hints after a Work-wide Discard, like an item's own command", async () => {
    await withHarness(async ({ queryClient, listed }) => {
      await settleReact(() => expect(listed()).toEqual(["draft-a"]));
      api.discardAllBranches.mockResolvedValue({
        status: "discarded",
        branchId: listing("draft-a").items[0].branchId,
      });
      const hints = projectQueryKeys.documentDraftHintsOf(input.projectId);
      queryClient.setQueryData([...hints, "doc-a"], { branches: [] });
      await act(async () => {
        await runWorkWideCommand(queryClient, input, "discard", [{ ...input }], null);
      });
      expect(queryClient.getQueryState([...hints, "doc-a"])?.isInvalidated).toBe(true);
    });
  });

  it("keeps a lost response unknown even when a remote Discard emptied the list", async () => {
    await withHarness(async ({ apply, listed }) => {
      await settleReact(() => expect(listed()).toEqual(["draft-a"]));
      api.applyDraft.mockRejectedValue(lost());
      api.listWorkBranches.mockResolvedValue(listing());
      await act(async () => {
        const done = apply();
        await vi.advanceTimersByTimeAsync(6000);
        expect(await done).toEqual({ kind: "apply-outcome-unknown" });
      });
      await settleReact(() => expect(listed()).toEqual([]));
    });
  });

  it("drops a confirmed draft at once, and no initial read that started earlier brings it back", async () => {
    // No cached list: nothing but the read fence can keep the older read's
    // draft out, since a later refetch would be cancelled by the invalidation.
    api.listWorkBranches.mockReturnValue(new Promise(() => undefined));
    await withHarness(async ({ apply, listed, queryClient }) => {
      const confirmation = deferred<unknown>();
      api.applyDraft.mockReturnValue(confirmation.promise);
      const older = deferred<ReturnType<typeof listing>>();
      let applied!: Promise<unknown>;
      await act(async () => {
        applied = apply();
      });
      api.listWorkBranches.mockReturnValueOnce(older.promise);
      await act(async () => {
        void queryClient.refetchQueries({ queryKey: ["projects", "project-a"] });
      });
      await act(async () => {
        confirmation.resolve({ status: "applied", itemKey: "draft-a" });
        await applied;
      });
      await act(async () => older.resolve(listing("draft-a")));
      await settleReact(() => expect(listed()).toEqual([]));
      expect(
        queryClient.getQueryData(projectQueryKeys.workBranches("project-a", "work-a")),
      ).toEqual(listing("draft-a").items);
    });
  });
});

it("an answer from before an account change cannot settle the new account's claim on the same draft", async () => {
  resetBranchCommandRecords();
  bindBranchCommandAccount("account-a");
  const selection = { classIds: ["c"], admissionTokens: ["c"], operationIds: ["1"] };
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
  client.setQueryData(
    projectQueryKeys.workBranches(input.projectId, input.workId),
    listing(input.itemKey).items,
  );
  const refresh = deferred<void>();
  const reads = vi.spyOn(client, "invalidateQueries").mockImplementation(() => refresh.promise);
  const old = startBranchCommand(client, command).outcome;
  oldAnswer.resolve({
    status: "applied",
    itemKey: input.itemKey,
    operationIds: ["1"],
    closureClassIds: ["c"],
  });
  await settleReact(() => expect(reads).toHaveBeenCalled());
  bindBranchCommandAccount("account-b");
  bindBranchCommandAccount("account-a");
  const newer = startBranchCommand(client, command).outcome;
  refresh.resolve();
  await expect(old).resolves.toEqual({ kind: "blocked" });
  expect(pendingBranchCommand(currentBranchCommandRecords(), input)).not.toBeNull();
  reads.mockRestore();
  newAnswer.resolve({
    status: "applied",
    itemKey: input.itemKey,
    operationIds: ["1"],
    closureClassIds: ["c"],
  });
  await newer;
  expect(pendingBranchCommand(currentBranchCommandRecords(), input)).toBeNull();
});

describe("clicks queued behind a Discard that re-forked the draft", () => {
  const scope = { projectId: input.projectId, workId: input.workId };
  const target = { documentId: input.documentId, itemKey: input.itemKey };
  // Two independent changes with the very same text: only the part key tells them apart.
  const op = (id: string, partKey: string) => ({
    operationId: id,
    partKey,
    closureClassId: `class-${partKey}`,
    admissionToken: `evidence-${partKey}`,
    kind: "writer" as const,
    classification: "addition" as const,
    beforeExcerpt: "same",
    afterExcerpt: "same words",
  });
  const preview = (generation: number, ...operations: ReturnType<typeof op>[]) => ({
    status: "active" as const,
    branchId: listed.branchId,
    item: { ...listed, documentId: input.documentId, itemKey: input.itemKey },
    itemKey: input.itemKey,
    draftGeneration: generation,
    reviewRoomName: "room",
    liveRevisionToken: "live",
    draftRevisionToken: `draft-${generation}`,
    operations,
    hunks: [],
  });
  const selecting = (o: ReturnType<typeof op>) => ({
    classIds: [o.closureClassId],
    admissionTokens: [o.admissionToken],
    operationIds: [o.operationId],
    keys: [o.partKey],
  });
  const discarded = { status: "discarded", itemKey: input.itemKey, itemClosed: false };
  const seeded = (...operations: ReturnType<typeof op>[]) => {
    resetBranchCommandRecords();
    bindBranchCommandAccount("account-a");
    api.discardDraft.mockReset();
    api.getDraftPreview.mockReset();
    const client = new QueryClient();
    client.setQueryData(
      projectQueryKeys.workBranches(input.projectId, input.workId),
      listing(input.itemKey).items,
    );
    client.setQueryData(
      projectQueryKeys.workBranchPreview(
        input.projectId,
        input.workId,
        input.documentId,
        input.itemKey,
      ),
      preview(1, ...operations),
    );
    return client;
  };

  it("keeps each queued caller's members and thread authority across a refork", async () => {
    const [a, b, c, d] = [op("2", "a"), op("3", "b"), op("4", "c"), op("5", "d")];
    const client = seeded(a, b, c, d);
    const invalidations = vi.spyOn(client, "invalidateQueries");
    const firstAnswer = deferred<unknown>();
    api.discardDraft.mockReturnValueOnce(firstAnswer.promise).mockResolvedValue(discarded);
    api.getDraftPreview.mockResolvedValue(
      preview(
        2,
        op("30", "b"),
        op("40", "c"),
        { ...op("50", "d"), admissionToken: "changed-effect" },
        {
          ...op("5", "writer-new"),
          closureClassId: c.closureClassId,
          admissionToken: c.admissionToken,
        },
      ),
    );
    const first = runDraftSelection(client, scope, "discard", target, selecting(a), "thread-a");
    const second = runDraftSelection(client, scope, "discard", target, selecting(b), "thread-b");
    const third = runDraftSelection(client, scope, "discard", target, selecting(c), "thread-c");
    firstAnswer.resolve(discarded);
    const fourth = runDraftSelection(client, scope, "discard", target, selecting(d), "thread-d");
    const outcomes = await Promise.all([first, second, third, fourth]);
    expect(outcomes).toEqual([
      { kind: "change-settled", mode: "discard" },
      { kind: "change-settled", mode: "discard" },
      { kind: "change-refused", mode: "discard", code: "stale" },
      { kind: "change-refused", mode: "discard", code: "stale" },
    ]);
    expect(api.discardDraft).toHaveBeenCalledTimes(2);
    expect(api.discardDraft.mock.calls[0]?.[3]).toMatchObject({
      closureClassIds: [a.closureClassId],
      admissionTokens: [a.admissionToken],
      memberPartKeys: [a.partKey],
      memberPartKeysComplete: true,
    });
    expect(api.discardDraft.mock.calls[1]?.[3]).toMatchObject({
      closureClassIds: [b.closureClassId],
      admissionTokens: [b.admissionToken],
      memberPartKeys: [b.partKey],
    });
    for (const call of api.discardDraft.mock.calls)
      expect(call[3]).not.toHaveProperty("operationIds");
    for (const thread of ["thread-a", "thread-b"]) {
      expect(invalidations).toHaveBeenCalledWith({
        queryKey: threadQueryKeys.liveLineageRoot(thread),
      });
      expect(invalidations).toHaveBeenCalledWith({ queryKey: threadQueryKeys.snapshot(thread) });
    }
    expect([...intentKeys(currentChangeCommandRecords(), input).hidden]).not.toContain("c");
    expect([...intentKeys(currentChangeCommandRecords(), input).hidden]).not.toContain("d");
  });

  it("admits the entire batch at the click and revokes an unsent target in its draft queue", async () => {
    const [a, b, c] = [op("2", "a"), op("3", "b"), op("4", "c")];
    const client = seeded(a, b);
    const other = { ...input, documentId: "doc-b", itemKey: "draft-b" };
    client.setQueryData(
      projectQueryKeys.workBranchPreview(
        other.projectId,
        other.workId,
        other.documentId,
        other.itemKey,
      ),
      { ...preview(1, c), itemKey: other.itemKey },
    );
    const answer = deferred<unknown>();
    api.discardDraft.mockReturnValue(answer.promise);
    const first = runDraftSelection(client, scope, "discard", target, selecting(a), null);
    const batch = runDraftBatch(
      [
        { draft: target, selection: selecting(b) },
        { draft: other, selection: selecting(c) },
      ],
      (item) => runDraftSelection(client, scope, "discard", item.draft, item.selection, null),
    );
    expect([...intentKeys(currentChangeCommandRecords(), input).hidden]).toContain("b");
    expect([...intentKeys(currentChangeCommandRecords(), other).hidden]).toContain("c");
    await settleReact(() => expect(api.discardDraft).toHaveBeenCalledTimes(2));
    expect(api.discardDraft.mock.calls[1]?.[3]).toMatchObject({
      itemKey: "draft-b",
      closureClassIds: [c.closureClassId],
    });
    bindBranchCommandAccount("account-b");
    answer.resolve(discarded);
    const outcomes = await batch;
    await first;
    expect(outcomes.map((entry) => entry.outcome)).toEqual([
      { kind: "blocked" },
      { kind: "blocked" },
    ]);
    expect(api.discardDraft).toHaveBeenCalledTimes(2);
  });

  it("retries explicit stale once with fresh rows only for identical actionable members", async () => {
    const b = op("3", "b");
    const stale = { status: "stale", itemKey: input.itemKey };
    for (const situation of [
      "same",
      "joined",
      "changed-effect",
      "incomplete",
      "stale-again",
      "read-lost",
      "revoked",
      "transport",
      "permission",
    ] as const) {
      const client = seeded(b);
      const fresh = { ...preview(2, op("30", "b")), liveRevisionToken: "fresh-live" };
      if (situation === "changed-effect") fresh.operations[0].admissionToken = "changed-effect";
      if (situation === "joined")
        fresh.operations.push({ ...op("4", "writer"), closureClassId: b.closureClassId });
      api.getDraftPreview.mockImplementation(async () => {
        if (situation === "read-lost") throw lost();
        if (situation === "revoked") bindBranchCommandAccount("account-b");
        return situation === "incomplete"
          ? {
              ...fresh,
              operations: fresh.operations.map((operation) => ({
                ...operation,
                canApplyOrDiscard: false,
              })),
            }
          : fresh;
      });
      if (situation === "transport") api.discardDraft.mockRejectedValue(lost());
      else if (situation === "permission")
        api.discardDraft.mockRejectedValue(new HttpResponseError("Forbidden", 403, null));
      else
        api.discardDraft.mockResolvedValueOnce(stale).mockImplementation(async () => {
          expect(pendingBranchCommand(currentBranchCommandRecords(), input)?.draftGeneration).toBe(
            2,
          );
          return situation === "stale-again" ? stale : discarded;
        });
      const done = runDraftSelection(client, scope, "discard", target, selecting(b), null);
      if (situation === "transport") {
        vi.useFakeTimers();
        await vi.advanceTimersByTimeAsync(6000);
        vi.useRealTimers();
      }
      const outcome = await done;
      const retry = situation === "same" || situation === "stale-again";
      expect(api.discardDraft, situation).toHaveBeenCalledTimes(
        situation === "transport" ? 4 : retry ? 2 : 1,
      );
      if (retry)
        expect(api.discardDraft.mock.calls[1]?.[3]).toMatchObject({
          closureClassIds: [b.closureClassId],
          admissionTokens: [b.admissionToken],
          memberPartKeys: [b.partKey],
          draftRevisionToken: "draft-2",
          liveRevisionToken: "fresh-live",
        });
      expect(outcome.kind, situation).toBe(
        situation === "same"
          ? "change-settled"
          : situation === "revoked"
            ? "blocked"
            : "change-refused",
      );
      if (situation === "read-lost")
        expect(outcome).toEqual({ kind: "change-refused", mode: "discard", code: "stale" });
      if (situation !== "same")
        expect(
          [...intentKeys(currentChangeCommandRecords(), input).hidden],
          situation,
        ).not.toContain("b");
      client.clear();
    }
  });

  it("whole-draft commands share the selective queue and lose their unsent turn on account switch", async () => {
    const a = op("2", "edit-a:0");
    const client = seeded(a);
    const response = deferred<unknown>();
    api.discardDraft.mockReturnValue(response.promise);
    const first = runDraftSelection(client, scope, "discard", target, selecting(a), null);
    const send = vi.fn(() =>
      startBranchCommand(client, {
        target: "all",
        draft: input,
        mode: "apply",
        generation: 1,
      }),
    );
    const next = runWholeDraftIntent(input, "apply", send);
    expect(next.sent).toBe(false);
    expect(send).not.toHaveBeenCalled();
    bindBranchCommandAccount("account-b");
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
    bindBranchCommandAccount("account-b");
    bindBranchCommandAccount("account-a");
    read.resolve(preview(2, op("30", "edit-b:0"), op("40", "edit-c:0")));
    const outcomes = await Promise.all(clicks);
    expect(api.discardDraft).toHaveBeenCalledTimes(1);
    expect(outcomes.slice(1)).toEqual([{ kind: "blocked" }, { kind: "blocked" }]);
  });
});

describe("command-record outcome matrix", () => {
  let client: QueryClient;
  const basis = { liveRevisionToken: "live", draftRevisionToken: "draft", draftGeneration: 1 };
  const selection = {
    operationIds: ["1"],
    classIds: ["c"],
    admissionTokens: ["clicked"],
    keys: ["part:0"],
  };
  const command = {
    target: "selection" as const,
    draft: input,
    mode: "apply" as const,
    basis,
    selection,
    completesDraft: false,
  };
  const result = (itemClosed: boolean) => ({
    status: "applied" as const,
    branchId: listed.branchId,
    itemKey: input.itemKey,
    operationIds: ["1"],
    closureClassIds: ["c"],
    itemClosed,
  });
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    resetBranchCommandRecords();
    client = new QueryClient();
    client.setQueryData(
      projectQueryKeys.workBranches(input.projectId, input.workId),
      listing(input.itemKey).items,
    );
  });
  afterEach(() => {
    client.clear();
    vi.useRealTimers();
  });

  it.each([
    false,
    true,
  ])("settles pending Apply from its own result (itemClosed=%s), never list absence", async (itemClosed) => {
    api.applyDraftChanges.mockResolvedValue({
      status: "pending",
      branchId: listed.branchId,
      commandId: "held",
    });
    const observed = deferred<unknown>();
    api.observeBranchCommand.mockReturnValue(observed.promise);
    const refresh = deferred<void>();
    vi.spyOn(client, "invalidateQueries").mockReturnValue(refresh.promise);
    const done = startBranchCommand(client, command).outcome;
    client.setQueryData(projectQueryKeys.workBranches(input.projectId, input.workId), []);
    await vi.advanceTimersByTimeAsync(1000);
    expect(pendingBranchCommand(currentBranchCommandRecords(), input)).not.toBeNull();
    observed.resolve({ state: "done", result: result(itemClosed) });
    await vi.advanceTimersByTimeAsync(0);
    const pending = pendingBranchCommand(currentBranchCommandRecords(), input);
    expect(Boolean(pending?.itemClosed)).toBe(itemClosed);
    expect(pending?.draftGeneration).toBe(1);
    refresh.resolve();
    expect(await done).toEqual({ kind: "change-settled", mode: "apply" });
    expect([...intentKeys(currentChangeCommandRecords(), input).hidden]).toEqual(["part:0"]);
    expect(api.applyDraftChanges).toHaveBeenCalledTimes(1);
  });

  it.each([
    "stale",
    "held",
  ] as const)("pending item Apply then %s restores the item without closure", async (status) => {
    api.applyDraft.mockResolvedValue({ status: "pending", branchId: listed.branchId });
    api.observeBranchCommand.mockResolvedValue({
      state: "done",
      result: {
        status,
        branchId: listed.branchId,
        itemKey: input.itemKey,
        reason: { code: "path_taken", path: "/chapter" },
      },
    });
    const done = startBranchCommand(client, {
      target: "all",
      mode: "apply",
      draft: input,
      generation: 1,
      completesDraft: true,
    }).outcome;
    await vi.advanceTimersByTimeAsync(1000);
    expect(await done).toMatchObject({
      kind: "failed",
      failure: { code: "apply-refused", serverCode: status === "held" ? "path_taken" : "stale" },
    });
    expect(pendingBranchCommand(currentBranchCommandRecords(), input)).toBeNull();
    expect([...intentKeys(currentChangeCommandRecords(), input).hidden]).toEqual([]);
  });

  it("blocked stops polling and ends the claim without a new command or closure", async () => {
    api.applyDraftChanges.mockResolvedValue({ status: "pending", branchId: listed.branchId });
    api.observeBranchCommand.mockResolvedValue({ state: "blocked" });
    const done = startBranchCommand(client, command).outcome;
    await vi.advanceTimersByTimeAsync(1000);
    expect(await done).toEqual({ kind: "change-refused", mode: "apply", code: "blocked" });
    expect(pendingBranchCommand(currentBranchCommandRecords(), input)).toBeNull();
    expect([...intentKeys(currentChangeCommandRecords(), input).hidden]).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.observeBranchCommand).toHaveBeenCalledTimes(1);
    expect(api.applyDraftChanges).toHaveBeenCalledTimes(1);
  });

  it.each([
    "selection",
    "item",
    "discard",
  ] as const)("lost %s transport resends the frozen body with the same id", async (target) => {
    const endpoint =
      target === "selection"
        ? api.applyDraftChanges
        : target === "item"
          ? api.applyDraft
          : api.discardDraft;
    endpoint.mockRejectedValueOnce(lost()).mockResolvedValue(
      target === "selection"
        ? result(false)
        : target === "item"
          ? {
              status: "applied",
              itemKey: input.itemKey,
              branchId: listed.branchId,
              item: { itemKey: input.itemKey, status: "applied", notes: [] },
            }
          : {
              status: "discarded",
              itemKey: input.itemKey,
              branchId: listed.branchId,
              itemClosed: true,
            },
    );
    const done = startBranchCommand(
      client,
      target === "selection"
        ? command
        : {
            target: "all",
            draft: input,
            mode: target === "discard" ? "discard" : "apply",
            generation: 1,
            completesDraft: true,
          },
    ).outcome;
    await vi.advanceTimersByTimeAsync(500);
    expect((await done).kind).toBe(
      target === "selection" ? "change-settled" : target === "item" ? "applied" : "discarded",
    );
    expect(endpoint.mock.calls[0]?.[3]).toEqual(endpoint.mock.calls[1]?.[3]);
    expect(endpoint.mock.calls[0]?.[3].commandId).toEqual(expect.any(String));
  });

  it("unknown_command observation resends, and a stored result settles the original id", async () => {
    api.applyDraftChanges
      .mockResolvedValueOnce({ status: "pending", branchId: listed.branchId })
      .mockResolvedValue(result(false));
    api.observeBranchCommand.mockResolvedValue({ state: "unknown" });
    const done = startBranchCommand(client, command).outcome;
    await vi.advanceTimersByTimeAsync(1500);
    expect(await done).toEqual({ kind: "change-settled", mode: "apply" });
    expect(api.applyDraftChanges.mock.calls[0]?.[3]).toEqual(
      api.applyDraftChanges.mock.calls[1]?.[3],
    );
  });
  it("applies two branchless items in one Work independently, each by its own itemKey", async () => {
    const branchless = (itemKey: string) => ({
      ...listed,
      itemKey,
      documentId: itemKey,
      draftGeneration: null,
      isNew: true,
      wholeItem: true,
    });
    client.setQueryData(projectQueryKeys.workBranches(input.projectId, input.workId), [
      branchless("a"),
      branchless("b"),
    ]);
    api.applyDraft.mockImplementation(async (_p, _w, _d, body) => ({
      status: "applied",
      branchId: listed.branchId,
      itemKey: body.itemKey,
      item: { itemKey: body.itemKey, status: "applied", notes: [] },
    }));
    const apply = (itemKey: string) =>
      startBranchCommand(client, {
        target: "all",
        mode: "apply",
        generation: 1,
        completesDraft: false,
        draft: { ...input, itemKey, documentId: itemKey },
      }).outcome;
    const [a, b] = await Promise.all([apply("a"), apply("b")]);
    expect([a.kind, b.kind]).toEqual(["applied", "applied"]);
    const [first, second] = api.applyDraft.mock.calls.map((call) => call[3]);
    expect([first.itemKey, second.itemKey]).toEqual(["a", "b"]);
    expect(first.commandId).not.toEqual(second.commandId);
  });
  it("discards a corrupt item missing from the list using the preview's branchId", async () => {
    client.setQueryData(projectQueryKeys.workBranches(input.projectId, input.workId), []);
    client.setQueryData(
      projectQueryKeys.workBranchPreview(
        input.projectId,
        input.workId,
        input.documentId,
        input.itemKey,
      ),
      { status: "corrupt", branchId: "draft-id-x", itemKey: input.itemKey, draftGeneration: 1 },
    );
    api.discardDraft.mockResolvedValue({
      status: "discarded",
      branchId: "draft-id-x",
      itemKey: input.itemKey,
    });
    startBranchCommand(client, { target: "all", mode: "discard", generation: 1, draft: input });
    await vi.waitFor(() => expect(api.discardDraft).toHaveBeenCalled());
    expect(api.discardDraft.mock.calls[0][3]).toEqual({
      commandId: expect.any(String),
      branchId: "draft-id-x",
      itemKey: input.itemKey,
    });
  });
});
