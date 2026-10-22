// @vitest-environment jsdom
/** Journal row ownership and Edit's safe transfer boundary. */
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HttpResponseError } from "@/client/api/http-client";
import { getThreadSnapshot } from "@/client/api/threads-api";
import {
  bindChatSubmissions,
  type ChatSubmission,
  chatSubmissionStorageKey,
  readChatSubmissions,
  recordChatSubmission,
  retireChatSubmission,
  subscribeChatSubmissions,
} from "@/client/chat-submissions";
import { MemorySubmissionLock } from "@/client/chat-submissions/adapters/memory-lock";
import { ComposerSessionDraft, composerSessionDraft } from "@/client/composer-drafts";
import {
  defaultSendResponse,
  scenarioGate,
  ThreadRunScenario,
} from "@/client/copilot/test-support/ThreadRunScenario";
import {
  plainComposerDoc,
  serializeComposerDraft,
} from "@/components/app/composer/composer-document";
import { ChatSubmissionOwner } from "./owner";

vi.mock("@/client/api/threads-api", async (actual) => ({
  ...(await actual<typeof import("@/client/api/threads-api")>()),
  getThreadSnapshot: vi.fn(),
  enqueueThreadControl: vi.fn(),
}));

let account = "account-1";
let accountSequence = 0;
let cleanup: (() => Promise<void>) | undefined;
function entry(id = "one", text = "First rejected"): ChatSubmission {
  const envelope = serializeComposerDraft(plainComposerDoc(text));
  return {
    ...envelope,
    recordId: id,
    submissionId: id,
    threadId: "thread_1",
    projectId: "project-1",
    createdAt: `2026-10-11T00:00:0${id === "one" ? 1 : 2}Z`,
    seq: id === "one" ? 1 : 2,
    blocks: [...envelope.blocks],
    references: [...envelope.references],
    activatedSkillSlugs: [...envelope.activatedSkillSlugs],
    state: "rejected",
  };
}
async function mount(scenario: ThreadRunScenario, paused = false) {
  const client = new QueryClient();
  const dissolved = vi.fn();
  const focused = vi.fn();
  const life = new AbortController();
  const owner = new ChatSubmissionOwner({
    accountId: account,
    threadId: "thread_1",
    projectId: "project-1",
    signal: life.signal,
    current: () => !life.signal.aborted,
    controller: scenario.controller,
    actions: scenario.store.getState(),
    queryClient: client,
    changed: () => {},
    focusComposer: focused,
    dissolveChat: dissolved,
  });
  owner.rebuild();
  const unsubscribe = paused ? () => {} : subscribeChatSubmissions(owner.rebuild);
  const previousCleanup = cleanup;
  cleanup = async () => {
    await previousCleanup?.();
    life.abort();
    unsubscribe();
    owner.dispose();
    scenario.controller.dispose();
    client.clear();
  };
  return {
    read: () => owner,
    client,
    dissolved,
    focused,
    dispose: () => {
      life.abort();
      unsubscribe();
      owner.dispose();
    },
  };
}
beforeEach(() => {
  account = `account-${++accountSequence}`;
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.mocked(getThreadSnapshot).mockReset();
  vi.mocked(getThreadSnapshot).mockRejectedValue(new HttpResponseError("missing", 404, null));
  bindChatSubmissions("reset");
  bindChatSubmissions(account);
  composerSessionDraft(account, { kind: "chat", id: "thread_1" }).handoff();
  composerSessionDraft(account, { kind: "new-chat", id: "project-1" }).handoff();
  const lock = new MemorySubmissionLock();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: (_name: string, options: { signal: AbortSignal }, run: () => Promise<unknown>) =>
        lock.run(account, "thread_1", options.signal, run),
    },
  });
});
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  window.localStorage.clear();
  window.sessionStorage.clear();
});

it("Edit bridges an already-accepted submission rather than returning delivered words", async () => {
  recordChatSubmission(account, { ...entry(), posted: true });
  const scenario = new ThreadRunScenario({
    retire: async ({ submissionId }) => ({
      kind: "already-accepted",
      submissionId,
      ...defaultSendResponse(),
    }),
  });
  const mounted = await mount(scenario);
  const row = scenario.turns()[0];
  if (!row) throw new Error("No row");
  mounted.read().presentation.get(row.id)?.onEdit?.();
  await vi.waitFor(() => expect(readChatSubmissions(account)).toEqual([]));
  expect(scenario.turns().map((turn) => turn.id)).toEqual([defaultSendResponse().userTurnId]);
  expect(composerSessionDraft(account, { kind: "chat", id: "thread_1" }).initialDraft).toBeNull();
  expect(scenario.appendRequests).toHaveLength(0);
});

it("Edit leaves a pending admission and its writer row untouched", async () => {
  recordChatSubmission(account, { ...entry(), posted: true });
  const scenario = new ThreadRunScenario({
    retire: async ({ submissionId }) => ({ kind: "pending", submissionId }),
  });
  const mounted = await mount(scenario);
  const row = scenario.turns()[0];
  if (!row) throw new Error("No row");
  mounted.read().presentation.get(row.id)?.onEdit?.();
  await vi.waitFor(() => expect(scenario.retireRequests).toHaveLength(1));
  expect(readChatSubmissions(account)).toHaveLength(1);
  expect(scenario.turns()).toEqual([expect.objectContaining({ id: row.id, status: "error" })]);
  expect(composerSessionDraft(account, { kind: "chat", id: "thread_1" }).initialDraft).toBeNull();
});

it("Edit dissolves every never-created message in order before newer New chat writing", async () => {
  const creation = {
    title: "Opening",
    workId: null,
    workAiWriteMode: "direct" as const,
    agentName: "General",
    agentSlug: "general",
    agentSelection: { catalogEntryId: "general", definitionRevisionId: "rev" },
  };
  recordChatSubmission(account, { ...entry(), creation });
  recordChatSubmission(account, { ...entry("two", "Second rejected"), creation });
  // A switch queued behind the refused creation has no words; Edit takes it with the cohort.
  recordChatSubmission(account, {
    ...entry("mode", ""),
    state: undefined,
    blocks: [],
    references: [],
    text: "",
    draft: undefined,
    control: { kind: "write_mode", mode: "draft" },
    creation,
  });
  composerSessionDraft(account, { kind: "chat", id: "thread_1" }).prependSnapshots([
    serializeComposerDraft(plainComposerDoc("Third unsent")).draft,
  ]);
  composerSessionDraft(account, { kind: "new-chat", id: "project-1" }).prependSnapshots([
    serializeComposerDraft(plainComposerDoc("Fourth existing")).draft,
  ]);
  const scenario = new ThreadRunScenario();
  const mounted = await mount(scenario);
  const row = scenario.turns()[0];
  if (!row) throw new Error("No row");
  mounted.read().presentation.get(row.id)?.onEdit?.();
  await vi.waitFor(() => expect(readChatSubmissions(account)).toEqual([]));
  const draft = composerSessionDraft(account, { kind: "new-chat", id: "project-1" }).initialDraft;
  if (!draft) throw new Error("No transferred draft");
  expect(serializeComposerDraft(draft.doc).text).toBe(
    "First rejected\n\nSecond rejected\n\nThird unsent\n\nFourth existing",
  );
  expect(scenario.turns()).toEqual([]);
  expect(mounted.dissolved).toHaveBeenCalledOnce();
  expect(scenario.retireRequests).toHaveLength(0);
});

it("cross-tab updates preserve failure identity and retire failed or pending writer rows", async () => {
  recordChatSubmission(account, { ...entry(), state: undefined });
  const scenario = new ThreadRunScenario({
    append: async () => {
      throw new TypeError("Lost send");
    },
  });
  const mounted = await mount(scenario);
  expect(scenario.turns()).toHaveLength(1);
  const row = scenario.turns()[0];
  if (!row) throw new Error("No row");
  await mounted.read().driver.drive("thread_1");
  await vi.waitFor(() => expect(mounted.read().presentation.get(row.id)?.failure).toBeDefined());
  const before = mounted.read().presentation.get(row.id)?.failure;
  const key = chatSubmissionStorageKey(account, "one");
  const raw = JSON.parse(window.localStorage.getItem(key) ?? "{}");
  raw.payload.occurrence = { requestId: "other-tab", attempt: (before?.attempt ?? 0) + 1 };
  window.localStorage.setItem(key, JSON.stringify(raw));
  window.dispatchEvent(new StorageEvent("storage", { key, storageArea: window.localStorage }));
  expect(mounted.read().presentation.get(row.id)?.failure).toEqual(before);
  recordChatSubmission(account, {
    ...entry(),
    recordId: "two",
    submissionId: "two",
    state: undefined,
  });
  expect(scenario.turns()).toHaveLength(2);
  expect(scenario.turns().some((turn) => turn.status === "pending")).toBe(true);
  window.localStorage.removeItem(key);
  window.dispatchEvent(new StorageEvent("storage", { key, storageArea: window.localStorage }));
  expect(scenario.turns()).toHaveLength(1);
  const pendingKey = chatSubmissionStorageKey(account, "two");
  window.localStorage.removeItem(pendingKey);
  window.dispatchEvent(
    new StorageEvent("storage", { key: pendingKey, storageArea: window.localStorage }),
  );
  expect(scenario.turns()).toEqual([]);
  expect(mounted.dissolved).not.toHaveBeenCalled();
});

it("dissolves this pane without retiring a message recorded after the transfer read", async () => {
  const creation = {
    title: "Opening",
    workId: null,
    workAiWriteMode: "direct" as const,
    agentName: "General",
    agentSlug: "general",
    agentSelection: { catalogEntryId: "general", definitionRevisionId: "rev" },
  };
  recordChatSubmission(account, { ...entry(), creation });
  const scenario = new ThreadRunScenario();
  const mounted = await mount(scenario);
  const row = scenario.turns()[0];
  if (!row) throw new Error("No row");
  const destination = composerSessionDraft(account, { kind: "new-chat", id: "project-1" });
  const write = Storage.prototype.setItem;
  let concurrent = false;
  const intercept = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
    this: Storage,
    key,
    value,
  ) {
    write.call(this, key, value);
    if (key === destination.key && !concurrent) {
      concurrent = true;
      recordChatSubmission(account, {
        ...entry("late", "A later send"),
        state: undefined,
        creation,
      });
    }
  });
  try {
    mounted.read().presentation.get(row.id)?.onEdit?.();
    await vi.waitFor(() =>
      expect(readChatSubmissions(account).map((record) => record.recordId)).toEqual(["late"]),
    );
    expect(readChatSubmissions(account)[0]?.creation).toEqual(creation);
    expect(mounted.dissolved).toHaveBeenCalledOnce();
    expect(
      destination.initialDraft && serializeComposerDraft(destination.initialDraft.doc).text,
    ).toBe("First rejected");
  } finally {
    intercept.mockRestore();
  }
});

it("a delayed observer of creation then acceptance loads the real destination, never dissolves", async () => {
  const creation = {
    title: "Opening",
    workId: null,
    workAiWriteMode: "direct" as const,
    agentName: "General",
    agentSlug: "general",
    agentSelection: { catalogEntryId: "general", definitionRevisionId: "rev" },
  };
  recordChatSubmission(account, { ...entry(), creation });
  const scenario = new ThreadRunScenario();
  const mounted = await mount(scenario, true);
  const thread = {
    id: "thread_1",
    userId: account,
    projectId: "project-1",
    title: "Opening",
    workId: null,
    createdAt: "2026-10-11T00:00:00Z",
    updatedAt: "2026-10-11T00:00:00Z",
  };
  vi.mocked(getThreadSnapshot).mockResolvedValue({
    thread,
    turns: [],
    state: null,
    hasMore: false,
  } as unknown as Awaited<ReturnType<typeof getThreadSnapshot>>);
  recordChatSubmission(account, { ...entry(), creation: undefined });
  retireChatSubmission(account, "one");
  mounted.read().rebuild();
  await vi.waitFor(() => expect(getThreadSnapshot).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(scenario.turns()).toEqual([]));
  expect(mounted.dissolved).not.toHaveBeenCalled();
});

it("failed journal reads preserve the last row and destination", async () => {
  recordChatSubmission(account, entry());
  const scenario = new ThreadRunScenario();
  const mounted = await mount(scenario);
  const prior = scenario.turns();
  const intercept = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("storage unavailable");
  });
  try {
    mounted.read().rebuild();
    expect(scenario.turns()).toEqual(prior);
    expect(mounted.dissolved).not.toHaveBeenCalled();
  } finally {
    intercept.mockRestore();
  }
});

it("committed Send stays successful when a synchronous subscriber throws", async () => {
  const reported = vi.fn();
  vi.stubGlobal("reportError", reported);
  const cause = new Error("subscriber invariant");
  const unsubscribe = subscribeChatSubmissions(() => {
    throw cause;
  });
  const scenario = new ThreadRunScenario({ lookup: () => scenarioGate<never>().promise });
  const mounted = await mount(scenario);
  try {
    expect(
      await mounted.read().submit(serializeComposerDraft(plainComposerDoc("Owned words"))),
    ).toBe(true);
    expect(readChatSubmissions(account)).toHaveLength(1);
    expect(reported).toHaveBeenCalledWith(cause);
  } finally {
    unsubscribe();
    vi.unstubAllGlobals();
  }
});

it("a refused Retry rewrite retains an actionable row but does not authorize Edit", async () => {
  recordChatSubmission(account, entry());
  const scenario = new ThreadRunScenario();
  const mounted = await mount(scenario);
  const row = scenario.turns()[0];
  if (!row) throw new Error("No row");
  const write = Storage.prototype.setItem;
  const intercept = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
    this: Storage,
    key,
    value,
  ) {
    if (key.startsWith("meridian:chat-submissions:")) throw new Error("write refused");
    write.call(this, key, value);
  });
  try {
    const first = mounted.read().presentation.get(row.id)?.failure;
    await mounted.read().driver.retry("one");
    expect(first?.attempt).toBe(1);
    expect(mounted.read().presentation.get(row.id)?.failure?.attempt).toBe(2);
    expect(scenario.turns()[0]?.status).toBe("error");
    expect(mounted.read().presentation.get(row.id)?.onRetry).toBeTypeOf("function");
    expect(mounted.read().presentation.get(row.id)?.onEdit).toBeUndefined();
    expect(readChatSubmissions(account)[0]?.submissionId).toBe("one");
    expect(readChatSubmissions(account)[0]?.state).toBe("rejected");
  } finally {
    intercept.mockRestore();
  }
});

it("a chat send during creation hands off its chat draft even if projection throws", async () => {
  const envelope = serializeComposerDraft(plainComposerDoc("Second"));
  const source = composerSessionDraft(account, { kind: "chat", id: "thread_1" });
  source.updateDraft({ snapshot: envelope.draft, text: envelope.text });
  const scenario = new ThreadRunScenario();
  const actions = scenario.store.getState();
  const mounted = await mount(scenario);
  recordChatSubmission(account, {
    ...entry(),
    creation: {
      title: "Opening",
      workId: null,
      workAiWriteMode: "direct",
      agentName: "General",
      agentSlug: "general",
      agentSelection: { catalogEntryId: "general", definitionRevisionId: "rev" },
    },
  });
  vi.stubGlobal("reportError", vi.fn());
  const fault = vi.spyOn(actions, "ensureThread").mockImplementation(() => {
    throw new Error("projection");
  });
  try {
    expect(await mounted.read().submit(envelope)).toBe(true);
    expect(source.initialDraft).toBeNull();
  } finally {
    fault.mockRestore();
    vi.unstubAllGlobals();
  }
});

it("two same-thread owners publish rejection and busy to the same readable snapshot", async () => {
  recordChatSubmission(account, { ...entry(), state: undefined });
  const gate = scenarioGate<never>();
  const scenario = new ThreadRunScenario({
    lookup: async ({ submissionId }) => ({ kind: "not-seen", submissionId }),
    append: async () => {
      throw new HttpResponseError("refused", 400, null);
    },
    retire: () => gate.promise,
  });
  const first = await mount(scenario);
  const second = await mount(scenario);
  const row = scenario.turns()[0];
  if (!row) throw new Error("No row");
  const id = row.id;
  await first.read().driver.drive("thread_1");
  expect(first.read().presentation.get(id)?.onEdit).toBeTypeOf("function");
  expect(second.read().presentation.get(id)?.onEdit).toBeTypeOf("function");
  first.read().presentation.get(id)?.onEdit?.();
  expect(second.read().presentation.get(id)?.busy).toBe(true);
  first.read().dispose();
});

it("Edit retirement refusal cannot duplicate a transferred record or leave Retry beside it", async () => {
  recordChatSubmission(account, { ...entry(), posted: true });
  const scenario = new ThreadRunScenario({
    retire: async ({ submissionId }) => ({ kind: "retired", submissionId, code: "retired" }),
  });
  const mounted = await mount(scenario);
  const row = scenario.turns()[0];
  if (!row) throw new Error("No row");
  const remove = Storage.prototype.removeItem;
  const fault = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (
    this: Storage,
    key,
  ) {
    if (key === chatSubmissionStorageKey(account, "one")) throw new Error("retirement refused");
    remove.call(this, key);
  });
  try {
    await mounted.read().driver.edit("one");
    await mounted.read().driver.edit("one");
    const draft = composerSessionDraft(account, { kind: "chat", id: "thread_1" }).initialDraft;
    expect(draft && serializeComposerDraft(draft.doc).text).toBe("First rejected");
    expect(mounted.read().presentation.get(row.id)?.moving).toBe(true);
    expect(mounted.read().presentation.get(row.id)?.onRetry).toBeUndefined();
    expect(mounted.read().presentation.get(row.id)?.onEdit).toBeUndefined();
    await mounted.read().driver.retry("one");
    expect(scenario.appendRequests).toHaveLength(0);
  } finally {
    fault.mockRestore();
  }
});

it("a received Edit survives draft reload and retries only retirement", async () => {
  recordChatSubmission(account, { ...entry(), posted: true });
  const scenario = new ThreadRunScenario({
    retire: async ({ submissionId }) => ({ kind: "retired", submissionId, code: "retired" }),
  });
  const mounted = await mount(scenario);
  const remove = Storage.prototype.removeItem;
  const fault = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (
    this: Storage,
    key,
  ) {
    if (key === chatSubmissionStorageKey(account, "one")) throw new Error("retirement refused");
    remove.call(this, key);
  });
  await mounted.read().driver.edit("one");
  fault.mockRestore();
  const reloaded = new ComposerSessionDraft(account, { kind: "chat", id: "thread_1" });
  expect(reloaded.hasReceived("one")).toBe(true);
  const snapshot = entry().draft;
  if (!snapshot) throw new Error("Missing draft");
  expect(reloaded.prependSnapshots([snapshot], ["one"])).toBe(true);
  expect(reloaded.initialDraft && serializeComposerDraft(reloaded.initialDraft.doc).text).toBe(
    "First rejected",
  );
  await mounted.read().driver.drive("thread_1");
  expect(readChatSubmissions(account)).toEqual([]);
  expect(scenario.retireRequests).toHaveLength(1);
  expect(scenario.appendRequests).toHaveLength(0);
});

it.each([
  "projection",
  "decoding",
] as const)("destination %s faults report their cause without resolving the destination", async (kind) => {
  recordChatSubmission(account, {
    ...entry(),
    creation: {
      title: "Opening",
      workId: null,
      workAiWriteMode: "direct",
      agentName: "General",
      agentSlug: "general",
      agentSelection: { catalogEntryId: "general", definitionRevisionId: "rev" },
    },
  });
  const scenario = new ThreadRunScenario();
  const actions = scenario.store.getState();
  const mounted = await mount(scenario);
  const snapshot = {
    thread: {
      id: "thread_1",
      userId: account,
      projectId: "project-1",
      title: "Opening",
      workId: null,
      createdAt: "2026-10-11T00:00:00Z",
      updatedAt: "2026-10-11T00:00:00Z",
    },
    turns: [],
    state: null,
    hasMore: false,
  } as unknown as Awaited<ReturnType<typeof getThreadSnapshot>>;
  vi.mocked(getThreadSnapshot).mockResolvedValue(
    kind === "decoding" ? (null as unknown as typeof snapshot) : snapshot,
  );
  const cause = new Error("destination projection");
  const reported = vi.fn();
  vi.stubGlobal("reportError", reported);
  const fault = vi.spyOn(actions, "ensureThread").mockImplementation(() => {
    throw cause;
  });
  try {
    retireChatSubmission(account, "one");
    await vi.waitFor(() =>
      expect(reported).toHaveBeenCalledWith(
        expect.objectContaining({
          message: kind === "projection" ? cause.message : "Thread snapshot response is empty",
        }),
      ),
    );
    expect(mounted.dissolved).not.toHaveBeenCalled();
    fault.mockRestore();
    vi.mocked(getThreadSnapshot).mockResolvedValue(snapshot);
    mounted.read().rebuild();
    await vi.waitFor(() => expect(getThreadSnapshot).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(scenario.turns()).toEqual([]));
  } finally {
    fault.mockRestore();
    vi.unstubAllGlobals();
  }
});

it("Edit focuses the invoking pane even when a sibling rebuilt last", async () => {
  recordChatSubmission(account, entry());
  const scenario = new ThreadRunScenario();
  const first = await mount(scenario);
  const second = await mount(scenario);
  const row = scenario.turns()[0];
  if (!row) throw new Error("No row");

  first.read().presentation.get(row.id)?.onEdit?.();

  await vi.waitFor(() => expect(readChatSubmissions(account)).toEqual([]));
  await vi.waitFor(() => expect(first.focused).toHaveBeenCalledOnce());
  expect(second.focused).not.toHaveBeenCalled();
  const draft = composerSessionDraft(account, { kind: "chat", id: "thread_1" }).initialDraft;
  expect(draft && serializeComposerDraft(draft.doc).text).toBe("First rejected");
});

it("disposing a sibling does not abandon the invoking pane's in-flight Edit", async () => {
  recordChatSubmission(account, { ...entry(), posted: true });
  const gate = scenarioGate<{ kind: "retired"; submissionId: string; code: "retired" }>();
  const scenario = new ThreadRunScenario({ retire: () => gate.promise });
  const first = await mount(scenario);
  const second = await mount(scenario);
  const row = scenario.turns()[0];
  if (!row) throw new Error("No row");

  first.read().presentation.get(row.id)?.onEdit?.();
  await vi.waitFor(() => expect(scenario.retireRequests).toHaveLength(1));
  expect(second.read().presentation.get(row.id)?.busy).toBe(true);
  second.dispose();
  gate.resolve({ kind: "retired", submissionId: "one", code: "retired" });

  await vi.waitFor(() => expect(readChatSubmissions(account)).toEqual([]));
  const draft = composerSessionDraft(account, { kind: "chat", id: "thread_1" }).initialDraft;
  expect(draft && serializeComposerDraft(draft.doc).text).toBe("First rejected");
  await vi.waitFor(() => expect(first.focused).toHaveBeenCalledOnce());
  expect(second.focused).not.toHaveBeenCalled();
});

it("retains an unsaved switch with distinct failed retry occurrences and local withdrawal", async () => {
  const scenario = new ThreadRunScenario();
  const mounted = await mount(scenario);
  const write = Storage.prototype.setItem;
  const intercept = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
    this: Storage,
    key,
    value,
  ) {
    if (key.startsWith("meridian:chat-submissions:")) throw new Error("write refused");
    write.call(this, key, value);
  });
  try {
    const owner = mounted.read();
    expect(owner.submitSwitch("unsaved", "draft")).toBe(false);
    expect(owner.switches).toMatchObject([
      {
        id: "unsaved",
        failed: true,
        posted: false,
        failure: { requestId: expect.any(String), attempt: 1, kind: "unsaved" },
      },
    ]);
    owner.retrySwitch("unsaved");
    expect(owner.switches[0]?.failure?.attempt).toBe(2);
    expect(readChatSubmissions(account)).toEqual([]);
    expect(await owner.withdrawSwitch("unsaved")).toBe("removed");
    expect(owner.switches).toEqual([]);
  } finally {
    intercept.mockRestore();
  }
});
