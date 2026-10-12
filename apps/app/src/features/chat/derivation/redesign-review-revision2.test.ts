// @vitest-environment jsdom

/** Revision-2 transfer seams: actual receipt and driver behavior that the new design must change. */
import { afterEach, expect, it, vi } from "vitest";
import { bindChatSubmissions, recordChatSubmission } from "@/client/chat-submissions";
import { ChatSubmissionOwner } from "@/client/chat-submissions/owner";
import { composerSessionDraft } from "@/client/composer-drafts";
import { ThreadRunScenario } from "@/client/copilot/test-support/ThreadRunScenario";
import {
  plainComposerDoc,
  serializeComposerDraft,
} from "@/components/app/composer/composer-document";
import { chatDerivationWitness, whenDerived } from "@/features/chat/derivation/derive-conversation";

vi.mock("@/client/chat-submissions/adapters/browser-lock", async () => {
  const { MemorySubmissionLock } = await import("@/client/chat-submissions/adapters/memory-lock");
  return { browserSubmissionLock: new MemorySubmissionLock() };
});
afterEach(() => vi.restoreAllMocks());
it("a received New-chat transfer is never admitted even without creation metadata", async () => {
  const account = "revision2-unmarked-receipt";
  bindChatSubmissions(account);
  const message = serializeComposerDraft(plainComposerDoc("Moved but still drivable"));
  recordChatSubmission(account, {
    ...message,
    recordId: "record",
    submissionId: "record",
    threadId: "thread_1",
    projectId: "project-1",
    createdAt: new Date().toISOString(),
  });
  const target = composerSessionDraft(account, { kind: "new-chat", id: "project-1" });
  expect(target.prependSnapshots([message.draft], ["record"])).toBe(true);
  const scenario = new ThreadRunScenario(),
    life = new AbortController();
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
    dissolveChat: () => {},
  });
  try {
    owner.rebuild();
    await owner.driver.drive("thread_1");
    expect(scenario.appendRequests).toHaveLength(0);
    expect(target.hasReceived("record")).toBe(true);
  } finally {
    life.abort();
    owner.dispose();
    scenario.controller.dispose();
  }
});
