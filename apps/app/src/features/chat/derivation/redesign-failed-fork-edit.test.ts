// @vitest-environment jsdom

/** Redesign probe: Edit on a send into a fork whose creation failed reads the fork's 404 as deletion. */
import { expect, it, vi } from "vitest";
import { MeridianApiError } from "@/client/api/meridian-error";
import {
  bindChatSubmissions,
  readChatSubmissions,
  subscribeChatSubmissions,
} from "@/client/chat-submissions";
import { ChatSubmissionOwner } from "@/client/chat-submissions/owner";
import { composerSessionDraft } from "@/client/composer-drafts";
import { ThreadRunScenario } from "@/client/copilot/test-support/ThreadRunScenario";
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

vi.mock("@/client/api/threads-api", async (actual) => ({
  ...(await actual()),
  forkThread: async () => {
    throw new Error("fork failed");
  },
}));
vi.mock("@/client/chat-submissions/adapters/browser-lock", async () => {
  const { MemorySubmissionLock } = await import("@/client/chat-submissions/adapters/memory-lock");
  return { browserSubmissionLock: new MemorySubmissionLock() };
});
const account = "account-1";

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
it("keeps a message sent into a fork whose creation failed when the writer clicks Edit", async () => {
  const reported = vi.fn();
  vi.stubGlobal("reportError", reported);
  bindChatSubmissions(account);
  // The fork was never created on the server, so every owner-gated request for it is a 404.
  const scenario = new ThreadRunScenario({
    lookup: async () => {
      throw missing();
    },
    retire: async () => {
      throw missing();
    },
  });
  const life = new AbortController();
  const forkId = startDerivation(
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
      accountSignal: life.signal,
      threadActions: scenario.store.getState(),
      source: null,
      inherited: null,
      open: () => {},
    },
  );
  expect(await whenDerived(forkId)).toBe(false);
  const owner = new ChatSubmissionOwner({
    accountId: account,
    threadId: forkId,
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
    dissolveChat: vi.fn(),
  });
  owner.rebuild();
  const unsubscribe = subscribeChatSubmissions(owner.rebuild);
  try {
    const projection = serializeComposerDraft(plainComposerDoc("Words sent into the new fork"));
    expect(
      await owner.submit({
        ...projection,
        submissionId: "fork-send",
        acceptedRevision: projection.draft.revision,
      }),
    ).toBe(true);
    await owner.driver.drive(forkId);
    // Derivation failed: the driver refuses the record without posting it, and Edit is offered.
    expect(readChatSubmissions(account)[0]?.state).toBe("rejected");
    expect(readChatSubmissions(account)[0]?.creation).toBeUndefined();
    await owner.driver.edit("fork-send");
    expect([...owner.presentation.values()][0]?.onRetry).toBeTypeOf("function");
    expect([...owner.presentation.values()][0]?.onEdit).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const draft = composerSessionDraft(account, { kind: "chat", id: forkId }).initialDraft;
    const where = {
      records: readChatSubmissions(account).map((e) => e.text),
      draft: draft && serializeComposerDraft(draft.doc).text,
      retires: scenario.retireRequests.length,
      reported: reported.mock.calls.map((c) => String(c[0])),
    };
    console.log("after Edit on a failed-fork send", where);
    expect(`${where.records.join("\n")}\n${where.draft ?? ""}`).toContain(
      "Words sent into the new fork",
    );
  } finally {
    resetDerivationsForTest();
    life.abort();
    unsubscribe();
    owner.dispose();
    scenario.controller.dispose();
    vi.unstubAllGlobals();
  }
});
