// @vitest-environment jsdom

/** Adversarial confirmation propagation using real owners, journal, driver, controller and drafts. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MeridianApiError } from "@/client/api/meridian-error";
import * as projectsApi from "@/client/api/projects-api";
import { getThreadSnapshot } from "@/client/api/threads-api";
import {
  bindChatSubmissions,
  forgetCreatedChat,
  readChatSubmissions,
  recordChatSubmission,
  retireChatSubmission,
  subscribeChatSubmissions,
} from "@/client/chat-submissions";
import { ChatSubmissionOwner } from "@/client/chat-submissions/owner";
import { composerSessionDraft } from "@/client/composer-drafts";
import { scenarioGate, ThreadRunScenario } from "@/client/copilot/test-support/ThreadRunScenario";
import {
  plainComposerDoc,
  serializeComposerDraft,
} from "@/components/app/composer/composer-document";
import { chatDerivationWitness, whenDerived } from "@/features/chat/derivation/derive-conversation";
import { makeOptimisticThread } from "@/lib/optimistic-thread";

vi.mock("@/client/api/threads-api", async (actual) => ({
  ...(await actual()),
  getThreadSnapshot: vi.fn(),
}));
vi.mock("@/client/chat-submissions/adapters/browser-lock", async () => {
  const { MemorySubmissionLock } = await import("@/client/chat-submissions/adapters/memory-lock");
  return { browserSubmissionLock: new MemorySubmissionLock() };
});
const account = "account-1";
const creation = {
  title: "Opening",
  workId: null,
  agentName: "General",
  agentSlug: "general",
  agentSelection: { catalogEntryId: "general", definitionRevisionId: "rev" },
};
const missing = () =>
  new MeridianApiError(
    {
      code: "thread_not_found",
      message: "Thread not found",
      source: "system",
      retryable: false,
      details: { authenticatedUserId: account },
    },
    404,
  );
const cleanup: Array<() => void> = [];
function mount(scenario: ThreadRunScenario) {
  const life = new AbortController();
  const dissolved = vi.fn();
  const owner = new ChatSubmissionOwner({
    accountId: account,
    threadId: "thread_1",
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
  });
  return { owner, dissolved };
}
beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  bindChatSubmissions("reset");
  bindChatSubmissions(account);
  recordChatSubmission(account, {
    ...serializeComposerDraft(plainComposerDoc("Original refused create")),
    recordId: "original",
    submissionId: "original",
    threadId: "thread_1",
    projectId: "project-1",
    createdAt: "2026-10-11T00:00:00Z",
    state: "rejected",
    creation,
  });
  vi.mocked(getThreadSnapshot).mockReset();
  vi.spyOn(projectsApi, "createProjectThread").mockResolvedValue(
    makeOptimisticThread({
      id: "thread_1",
      projectId: "project-1",
      title: "Opening",
      timestamp: new Date().toISOString(),
      workId: null,
      agent: { name: "General", slug: "general", selection: creation.agentSelection },
    }),
  );
});
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
  vi.restoreAllMocks();
});
it("clears observer provenance when a sibling confirms creation but admission is rejected", async () => {
  const scenario = new ThreadRunScenario({
    append: async () => {
      throw new MeridianApiError(
        { code: "invalid_request", message: "refused", source: "system", retryable: false },
        400,
      );
    },
  });
  cleanup.push(() => scenario.controller.dispose());
  const observer = mount(scenario);
  const sender = mount(scenario);
  await sender.owner.driver.retry("original");
  expect(projectsApi.createProjectThread).toHaveBeenCalledOnce();
  expect(readChatSubmissions(account)).toHaveLength(1);
  expect(readChatSubmissions(account)[0].creation).toBeUndefined();
  expect(readChatSubmissions(account)[0].state).toBe("rejected");
  const draft = composerSessionDraft(account, { kind: "chat", id: "thread_1" });
  draft.prependSnapshots([serializeComposerDraft(plainComposerDoc("Unsent words")).draft]);
  // A real Delete/attested missing response now invokes this exact cleanup operation.
  const forgotten = await forgetCreatedChat(account, "thread_1");
  console.log("after sibling create confirmation and later deletion", {
    senderCreating: sender.owner.creationState.kind === "root-unconfirmed",
    observerCreating: observer.owner.creationState.kind === "root-unconfirmed",
    snapshotChecks: vi.mocked(getThreadSnapshot).mock.calls.length,
    forgotten,
    records: readChatSubmissions(account).map((e) => ({ creation: e.creation, state: e.state })),
    draftRetained: !!draft.initialDraft,
  });
  expect(forgotten).toBe("forgotten");
});
it("does not dissolve a destination on a held missing response after a sibling has created and admitted it", async () => {
  const held = scenarioGate<never>();
  vi.mocked(getThreadSnapshot).mockImplementation(() => held.promise);
  const scenario = new ThreadRunScenario();
  cleanup.push(() => scenario.controller.dispose());
  const observer = mount(scenario);
  const sender = mount(scenario);
  retireChatSubmission(account, "original");
  expect(getThreadSnapshot).toHaveBeenCalledOnce();
  await sender.owner.submit(serializeComposerDraft(plainComposerDoc("New delivered words")));
  await sender.owner.driver.drive("thread_1");
  expect(scenario.appendRequests).toHaveLength(1);
  expect(readChatSubmissions(account)).toEqual([]);
  const source = composerSessionDraft(account, { kind: "chat", id: "thread_1" });
  source.prependSnapshots([serializeComposerDraft(plainComposerDoc("More unsent words")).draft]);
  held.reject(missing());
  await new Promise((resolve) => setTimeout(resolve, 30));
  console.log("held 404 after sibling confirmation", {
    senderCreating: sender.owner.creationState.kind === "root-unconfirmed",
    observerDissolved: observer.dissolved.mock.calls.length,
    senderDissolved: sender.dissolved.mock.calls.length,
    source: source.initialDraft,
    target: composerSessionDraft(account, { kind: "new-chat", id: "project-1" }).initialDraft,
  });
  expect(observer.dissolved).not.toHaveBeenCalled();
});
