// @vitest-environment jsdom
/** Apply is done at server confirmation; a lost response stays unknown; a confirmed draft never returns from an older read. */
import type { ThreadDraftListItem } from "@meridian/contracts/drafts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpResponseError } from "@/client/api/http-client";
import { settleReact, withReactRoot } from "@/test-support/react-dom-harness";
import {
  runDraftBatch,
  runDraftSelection,
  runWholeDraftIntent,
  startDraftCommand,
} from "./draft-command-executor";
import {
  bindDraftCommandAccount,
  currentChangeCommandRecords,
  currentDraftCommandRecords,
  intentKeys,
  pendingDraftCommand,
  resetDraftCommandRecords,
} from "./draft-command-record";
import { projectQueryKeys } from "./project-query-keys";
import { threadQueryKeys } from "./thread-query-keys";
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
  drafts: draftIds.map(
    (draftId) => ({ draftId, documentId: "doc-a", draftGeneration: 1 }) as ThreadDraftListItem,
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
  let drafts: string[] = [];
  function Capture() {
    drafts = (useWorkDrafts("project-a", "work-a").data ?? []).map((draft) => draft.draftId);
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
      expect(queryClient.getQueryData(projectQueryKeys.workDrafts("project-a", "work-a"))).toEqual(
        listing("draft-a").drafts,
      );
    });
  });
});

it("an answer from before an account change cannot settle the new account's claim on the same draft", async () => {
  resetDraftCommandRecords();
  bindDraftCommandAccount("account-a");
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

describe("clicks queued behind a Discard that re-forked the draft", () => {
  const scope = { projectId: input.projectId, workId: input.workId };
  const target = { documentId: input.documentId, draftId: input.draftId };
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
    admissionTokens: [o.admissionToken],
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
      operationIds: ["2"],
      admissionTokens: [a.admissionToken],
    });
    expect(api.discardDraft.mock.calls[1]?.[3]).toMatchObject({
      operationIds: ["30"],
      admissionTokens: [b.admissionToken],
    });
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
    const other = { ...input, documentId: "doc-b", draftId: "draft-b" };
    client.setQueryData(
      projectQueryKeys.workDraftPreview(
        other.projectId,
        other.workId,
        other.documentId,
        other.draftId,
      ),
      { ...preview(1, c), draftId: other.draftId },
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
      draftId: "draft-b",
      operationIds: ["4"],
    });
    bindDraftCommandAccount("account-b");
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
    const stale = { status: "stale", draftId: input.draftId };
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
        if (situation === "revoked") bindDraftCommandAccount("account-b");
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
          expect(pendingDraftCommand(currentDraftCommandRecords(), input)?.draftGeneration).toBe(2);
          return situation === "stale-again" ? stale : discarded;
        });
      const outcome = await runDraftSelection(client, scope, "discard", target, selecting(b), null);
      const retry = situation === "same" || situation === "stale-again";
      expect(api.discardDraft, situation).toHaveBeenCalledTimes(retry ? 2 : 1);
      if (retry)
        expect(api.discardDraft.mock.calls[1]?.[3]).toMatchObject({
          operationIds: ["30"],
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
      startDraftCommand(client, {
        target: "all",
        draft: input,
        mode: "apply",
        generation: 1,
      }),
    );
    const next = runWholeDraftIntent(input, "apply", send);
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
