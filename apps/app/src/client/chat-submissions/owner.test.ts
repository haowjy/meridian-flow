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
import { composerSessionDraft } from "@/client/composer-drafts";
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
}));

const account = "account-1";
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
    blocks: [...envelope.blocks],
    references: [...envelope.references],
    activatedSkillSlugs: [...envelope.activatedSkillSlugs],
    state: "rejected",
  };
}
async function mount(scenario: ThreadRunScenario, paused = false) {
  const client = new QueryClient();
  const dissolved = vi.fn();
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
    failed: () => {},
    clear: () => {},
    focusComposer: () => {},
    dissolveChat: dissolved,
  });
  owner.rebuild();
  const unsubscribe = paused ? () => {} : subscribeChatSubmissions(owner.rebuild);
  cleanup = async () => {
    life.abort();
    unsubscribe();
    owner.dispose();
    scenario.controller.dispose();
    client.clear();
  };
  return { read: () => owner, dissolved };
}
beforeEach(() => {
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
  recordChatSubmission(account, entry());
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
  mounted.read().rowActions(row.id)?.onEdit?.();
  await vi.waitFor(() => expect(readChatSubmissions(account)).toEqual([]));
  expect(scenario.turns().map((turn) => turn.id)).toEqual([defaultSendResponse().userTurnId]);
  expect(composerSessionDraft(account, { kind: "chat", id: "thread_1" }).initialDraft).toBeNull();
  expect(scenario.appendRequests).toHaveLength(0);
});

it("Edit leaves a pending admission and its writer row untouched", async () => {
  recordChatSubmission(account, entry());
  const scenario = new ThreadRunScenario({
    retire: async ({ submissionId }) => ({ kind: "pending", submissionId }),
  });
  const mounted = await mount(scenario);
  const row = scenario.turns()[0];
  if (!row) throw new Error("No row");
  mounted.read().rowActions(row.id)?.onEdit?.();
  await vi.waitFor(() => expect(scenario.retireRequests).toHaveLength(1));
  expect(readChatSubmissions(account)).toHaveLength(1);
  expect(scenario.turns()).toEqual([expect.objectContaining({ id: row.id, status: "error" })]);
  expect(composerSessionDraft(account, { kind: "chat", id: "thread_1" }).initialDraft).toBeNull();
});

it("Edit dissolves every never-created message in order before newer New chat writing", async () => {
  const creation = {
    title: "Opening",
    workId: null,
    agentName: "General",
    agentSlug: "general",
    agentSelection: { catalogEntryId: "general", definitionRevisionId: "rev" },
  };
  recordChatSubmission(account, { ...entry(), creation });
  recordChatSubmission(account, { ...entry("two", "Second rejected"), creation });
  composerSessionDraft(account, { kind: "chat", id: "thread_1" }).editRejected(
    serializeComposerDraft(plainComposerDoc("Third unsent")).draft,
  );
  composerSessionDraft(account, { kind: "new-chat", id: "project-1" }).editRejected(
    serializeComposerDraft(plainComposerDoc("Fourth existing")).draft,
  );
  const scenario = new ThreadRunScenario();
  const mounted = await mount(scenario);
  const row = scenario.turns()[0];
  if (!row) throw new Error("No row");
  mounted.read().rowActions(row.id)?.onEdit?.();
  await vi.waitFor(() => expect(readChatSubmissions(account)).toEqual([]));
  const draft = composerSessionDraft(account, { kind: "new-chat", id: "project-1" }).initialDraft;
  if (!draft) throw new Error("No transferred draft");
  expect(serializeComposerDraft(draft.doc).text).toBe(
    "First rejected\nSecond rejected\nThird unsent\nFourth existing",
  );
  expect(scenario.turns()).toEqual([]);
  expect(mounted.dissolved).toHaveBeenCalledOnce();
  expect(scenario.retireRequests).toHaveLength(0);
});

it("a cross-tab retirement removes an unresolved optimistic row, not just rejected rows", async () => {
  const gate = scenarioGate<never>();
  recordChatSubmission(account, { ...entry(), state: undefined });
  const scenario = new ThreadRunScenario({ lookup: () => gate.promise });
  const mounted = await mount(scenario);
  expect(scenario.turns()).toHaveLength(1);
  const key = chatSubmissionStorageKey(account, "one");
  window.localStorage.removeItem(key);
  window.dispatchEvent(new StorageEvent("storage", { key, storageArea: window.localStorage }));
  expect(scenario.turns()).toEqual([]);
  expect(mounted.dissolved).not.toHaveBeenCalled();
});

it("dissolves this pane without retiring a message recorded after the transfer read", async () => {
  const creation = {
    title: "Opening",
    workId: null,
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
    mounted.read().rowActions(row.id)?.onEdit?.();
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
    await mounted.read().driver.retry("one");
    expect(scenario.turns()[0]?.status).toBe("error");
    expect(mounted.read().rowActions(row.id)?.onRetry).toBeTypeOf("function");
    expect(mounted.read().rowActions(row.id)?.onEdit).toBeUndefined();
    expect(readChatSubmissions(account)[0]?.submissionId).toBe("one");
    expect(readChatSubmissions(account)[0]?.state).toBe("rejected");
  } finally {
    intercept.mockRestore();
  }
});
