// @vitest-environment jsdom
/** Edit owns words locally until a derivation can admit them; deletion still belongs to the server. */
import { QueryClient } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { MeridianApiError } from "@/client/api/meridian-error";
import {
  bindChatSubmissions,
  readChatSubmissions,
  subscribeChatSubmissions,
} from "@/client/chat-submissions";
import { composerSessionDraft } from "@/client/composer-drafts";
import { scenarioGate, ThreadRunScenario } from "@/client/copilot/test-support/ThreadRunScenario";
import {
  plainComposerDoc,
  serializeComposerDraft,
} from "@/components/app/composer/composer-document";
import {
  readDerivationIntent,
  resetDerivationsForTest,
  retryDerivation,
  startDerivation,
  whenDerived,
} from "@/features/chat/derivation/derive-conversation";
import { ChatSubmissionOwner } from "./owner";

const api = vi.hoisted(() => ({ forkThread: vi.fn() }));
vi.mock("@/client/api/threads-api", async (actual) => ({
  ...(await actual<typeof import("@/client/api/threads-api")>()),
  forkThread: api.forkThread,
}));
vi.mock("@/client/chat-submissions/adapters/browser-lock", async () => {
  const { MemorySubmissionLock } = await import("./adapters/memory-lock");
  return { browserSubmissionLock: new MemorySubmissionLock() };
});

const account = "failed-fork-edit-account";
let cleanup = () => {};
afterEach(() => {
  cleanup();
  resetDerivationsForTest();
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

async function failedFork() {
  bindChatSubmissions(account);
  const scenario = new ThreadRunScenario({
    retire: async () => {
      throw new MeridianApiError(
        { code: "thread_not_found", message: "Not found", source: "system", retryable: false },
        404,
      );
    },
  });
  const life = new AbortController();
  const deps = {
    accountId: account,
    accountSignal: life.signal,
    threadActions: {
      ensureThread: vi.fn(),
      markPendingCreation: vi.fn(),
      clearPendingCreation: vi.fn(),
    },
  };
  api.forkThread.mockRejectedValue(new Error("Fork creation refused"));
  const threadId = startDerivation(
    {
      kind: "fork",
      projectId: "project-1",
      sourceThreadId: "source",
      sourceTitle: "Source",
      originTurnId: "reply",
      workId: null,
      agent: null,
      agentName: "General",
    },
    { ...deps, source: null, inherited: null, open: () => {} },
  );
  expect(await whenDerived(threadId)).toBe(false);
  const queryClient = new QueryClient();
  const dissolveChat = vi.fn();
  const owner = new ChatSubmissionOwner({
    accountId: account,
    threadId,
    projectId: "project-1",
    signal: life.signal,
    current: () => !life.signal.aborted,
    controller: scenario.controller,
    actions: scenario.store.getState(),
    queryClient,
    changed: () => {},
    failed: () => {},
    clear: () => {},
    focusComposer: () => {},
    dissolveChat,
  });
  owner.rebuild();
  const unsubscribe = subscribeChatSubmissions(owner.rebuild);
  cleanup = () => {
    life.abort();
    unsubscribe();
    owner.dispose();
    scenario.controller.dispose();
    queryClient.clear();
  };
  const projection = serializeComposerDraft(plainComposerDoc("Make the elder colder"));
  expect(
    await owner.submit({
      ...projection,
      submissionId: "fork-send",
      acceptedRevision: projection.draft.revision,
    }),
  ).toBe(true);
  await owner.driver.drive(threadId);
  expect(readChatSubmissions(account)[0]?.state).toBe("rejected");
  return { owner, scenario, deps, threadId, dissolveChat };
}

it("Edit returns a failed fork send without contacting the server or retiring the fork intent", async () => {
  const { owner, scenario, deps, threadId, dissolveChat } = await failedFork();
  const intent = readDerivationIntent(account, threadId);
  expect(intent).not.toBeNull();
  await owner.driver.edit("fork-send");
  const draft = composerSessionDraft(account, { kind: "chat", id: threadId }).initialDraft;
  expect(draft && serializeComposerDraft(draft.doc).text).toBe("Make the elder colder");
  expect(readChatSubmissions(account)).toEqual([]);
  expect(scenario.turns(threadId)).toEqual([]);
  expect(scenario.lookupRequests).toHaveLength(0);
  expect(scenario.retireRequests).toHaveLength(0);
  expect(readDerivationIntent(account, threadId)).toEqual(intent);
  expect(dissolveChat).not.toHaveBeenCalled();
  api.forkThread.mockResolvedValue({ id: threadId });
  retryDerivation(threadId, deps);
  expect(await whenDerived(threadId)).toBe(true);
  await owner.driver.drive(threadId);
  expect(scenario.appendRequests).toHaveLength(0);
});

it("Edit waits for a pending fork retry, then fences the submission on the created chat", async () => {
  const { owner, scenario, deps, threadId } = await failedFork();
  const creating = scenarioGate<{ id: string }>();
  api.forkThread.mockReturnValue(creating.promise);
  retryDerivation(threadId, deps);
  let finished = false;
  const editing = owner.driver.edit("fork-send").then(() => {
    finished = true;
  });
  await Promise.resolve();
  expect(finished).toBe(false);
  expect(scenario.retireRequests).toHaveLength(0);
  expect(readChatSubmissions(account)).toHaveLength(1);
  creating.resolve({ id: threadId });
  await editing;
  // An inconclusive server answer must not authorize a local transfer once creation is acknowledged.
  expect(scenario.retireRequests).toHaveLength(1);
  expect(readChatSubmissions(account)).toHaveLength(1);
  expect(composerSessionDraft(account, { kind: "chat", id: threadId }).initialDraft).toBeNull();
});
