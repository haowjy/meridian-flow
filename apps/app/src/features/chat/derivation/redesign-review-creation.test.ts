// @vitest-environment jsdom

/** Design premise probes: real derivation, owner, journal and lock lifecycle. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as projectsApi from "@/client/api/projects-api";
import { forkThread } from "@/client/api/threads-api";
import {
  bindChatSubmissions,
  chatSubmissionStorageKey,
  readChatSubmissions,
  recordChatSubmission,
  subscribeChatSubmissions,
} from "@/client/chat-submissions";
import { browserSubmissionLock } from "@/client/chat-submissions/adapters/browser-lock";
import { ChatSubmissionOwner } from "@/client/chat-submissions/owner";
import { composerSessionDraft } from "@/client/composer-drafts";
import { scenarioGate, ThreadRunScenario } from "@/client/copilot/test-support/ThreadRunScenario";
import {
  plainComposerDoc,
  serializeComposerDraft,
} from "@/components/app/composer/composer-document";
import {
  chatDerivationWitness,
  resetDerivationsForTest,
  startDerivation,
  whenDerived,
} from "@/features/chat/derivation/derive-conversation";
import { makeOptimisticThread } from "@/lib/optimistic-thread";

vi.mock("@lingui/core/macro", () => ({
  t: (s: TemplateStringsArray) => s[0],
  msg: (s: TemplateStringsArray) => ({ id: s[0] }),
}));
vi.mock("@/client/api/threads-api", async (actual) => ({
  ...(await actual()),
  forkThread: vi.fn(),
  getThreadSnapshot: vi.fn(() => new Promise(() => {})),
}));
vi.mock("@/client/chat-submissions/adapters/browser-lock", async () => {
  const { MemorySubmissionLock } = await import("@/client/chat-submissions/adapters/memory-lock");
  return { browserSubmissionLock: new MemorySubmissionLock() };
});
let account = "redesign-review-account";
let counter = 0;
const creation = {
  title: "Opening",
  workId: null,
  agentName: "General",
  agentSlug: "general",
  agentSelection: { catalogEntryId: "general", definitionRevisionId: "rev" },
};
const cleanup: Array<() => void> = [];
function mount(scenario: ThreadRunScenario, threadId = "thread_1") {
  const life = new AbortController(),
    dissolved = vi.fn();
  const owner = new ChatSubmissionOwner({
    accountId: account,
    threadId,
    projectId: "project-1",
    signal: life.signal,
    current: () => !life.signal.aborted,
    controller: scenario.controller,
    actions: scenario.store.getState(),
    whenDerived,
    derivation: chatDerivationWitness(account),
    projectCreated: () => {},
    projectRemoved: () => {},
    changed: () => {},
    failed: () => {},
    clear: () => {},
    focusComposer: () => {},
    dissolveChat: dissolved,
  });
  owner.rebuild();
  const unsub = subscribeChatSubmissions(owner.rebuild);
  cleanup.push(() => {
    life.abort();
    unsub();
    owner.dispose();
    scenario.controller.dispose();
  });
  return { owner, life, dissolved };
}
function thread(id = "thread_1") {
  return makeOptimisticThread({
    id,
    projectId: "project-1",
    title: "Opening",
    timestamp: new Date().toISOString(),
    workId: null,
    agent: { name: "General", slug: "general", selection: creation.agentSelection },
  });
}
beforeEach(() => {
  account = `redesign-review-account-${++counter}`;
  localStorage.clear();
  sessionStorage.clear();
  resetDerivationsForTest();
  bindChatSubmissions("reset");
  bindChatSubmissions(account);
});
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
  vi.restoreAllMocks();
});
it("fork starts while its submission lock is held, and a Send to it writes no creation provenance", async () => {
  const held = scenarioGate<void>(),
    created = scenarioGate<ReturnType<typeof thread>>();
  const destination = "11111111-1111-4111-8111-111111111111";
  let locked = false;
  const holding = browserSubmissionLock.run(
    account,
    destination,
    new AbortController().signal,
    async () => {
      locked = true;
      await held.promise;
    },
  );
  await vi.waitFor(() => expect(locked).toBe(true));
  vi.spyOn(crypto, "randomUUID").mockReturnValueOnce(destination);
  vi.mocked(forkThread).mockReturnValueOnce(created.promise);
  const scenario = new ThreadRunScenario();
  const id = startDerivation(
    {
      kind: "fork",
      projectId: "project-1",
      sourceThreadId: "source",
      sourceTitle: "Source",
      originTurnId: "cut",
      workId: null,
      agent: null,
      agentName: "General",
    },
    {
      accountId: account,
      accountSignal: new AbortController().signal,
      threadActions: scenario.store.getState(),
      source: thread("source"),
      inherited: null,
      open: () => {},
    },
  );
  expect(id).toBe(destination);
  expect(forkThread).toHaveBeenCalled(); // Network creation did not acquire the held lock.
  const { owner } = mount(scenario, id);
  expect(
    await owner.submit(serializeComposerDraft(plainComposerDoc("Words while fork creates"))),
  ).toBe(true);
  expect(readChatSubmissions(account)[0].creation).toBeUndefined();
  expect(scenario.appendRequests).toHaveLength(0);
  created.resolve(thread(id));
  expect(await whenDerived(id)).toBe(true); // Creation completed while decision's lock is still held.
  held.resolve();
  await holding;
  await owner.driver.drive(id);
});
it("cancelling a driver releases its lock before its create operation has settled", async () => {
  const created = scenarioGate<ReturnType<typeof thread>>();
  let createSettled = false;
  const create = vi.spyOn(projectsApi, "createProjectThread").mockImplementation(async () => {
    const result = await created.promise;
    createSettled = true;
    return result;
  });
  recordChatSubmission(account, {
    ...serializeComposerDraft(plainComposerDoc("Original")),
    recordId: "original",
    submissionId: "original",
    threadId: "thread_1",
    projectId: "project-1",
    createdAt: new Date().toISOString(),
    creation,
  });
  const { owner, life } = mount(new ThreadRunScenario());
  const driving = owner.driver.drive("thread_1");
  await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
  life.abort();
  await driving;
  await browserSubmissionLock.run(account, "thread_1", new AbortController().signal, async () => {
    expect(createSettled).toBe(false);
    created.resolve(thread());
    await created.promise;
  });
  await vi.waitFor(() => expect(createSettled).toBe(true));
});
it("never-created Edit with refused journal retirement moves words but never publishes navigation or recovery commands", async () => {
  recordChatSubmission(account, {
    ...serializeComposerDraft(plainComposerDoc("Refused first send")),
    recordId: "original",
    submissionId: "original",
    threadId: "thread_1",
    projectId: "project-1",
    createdAt: new Date().toISOString(),
    creation,
    state: "rejected",
  });
  const { owner, dissolved } = mount(new ThreadRunScenario());
  const remove = Storage.prototype.removeItem;
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (
    this: Storage,
    key: string,
  ) {
    if (key === chatSubmissionStorageKey(account, "original"))
      throw new Error("retirement refused");
    remove.call(this, key);
  });
  await owner.driver.edit("original");
  expect(dissolved).not.toHaveBeenCalled();
  const draft = composerSessionDraft(account, { kind: "new-chat", id: "project-1" }).initialDraft;
  expect(draft && serializeComposerDraft(draft.doc).text).toBe("Refused first send");
  expect(readChatSubmissions(account)).toHaveLength(1);
  const row = [...owner.presentation.values()][0];
  expect(row.moving).toBe(true);
  expect(row.onEdit).toBeUndefined();
  expect(row.onRetry).toBeUndefined();
});
it("Edit fences a stale creation-bearing rejected record in an already confirmed destination", async () => {
  vi.spyOn(projectsApi, "createProjectThread").mockResolvedValue(thread());
  recordChatSubmission(account, {
    ...serializeComposerDraft(plainComposerDoc("First message")),
    recordId: "original",
    submissionId: "original",
    threadId: "thread_1",
    projectId: "project-1",
    createdAt: new Date().toISOString(),
    creation,
    state: "rejected",
  });
  const scenario = new ThreadRunScenario();
  const { owner, dissolved } = mount(scenario);
  await owner.driver.retry("original");
  expect(owner.creationState.kind === "root-unconfirmed").toBe(false);
  expect(scenario.appendRequests).toHaveLength(1);
  recordChatSubmission(account, {
    ...serializeComposerDraft(plainComposerDoc("Stale-tab refused message")),
    recordId: "stale",
    submissionId: "stale",
    threadId: "thread_1",
    projectId: "project-1",
    createdAt: new Date().toISOString(),
    creation,
    state: "rejected",
  });
  expect(owner.creationState.kind === "root-unconfirmed").toBe(false);
  await owner.driver.edit("stale");
  expect(scenario.retireRequests).toHaveLength(1);
  expect(dissolved).not.toHaveBeenCalled();
  const draft = composerSessionDraft(account, { kind: "chat", id: "thread_1" }).initialDraft;
  expect(draft && serializeComposerDraft(draft.doc).text).toContain("Stale-tab refused message");
});
