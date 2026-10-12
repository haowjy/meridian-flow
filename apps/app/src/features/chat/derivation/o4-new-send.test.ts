// @vitest-environment jsdom

/** Real owner + driver + journal: Send while another tab's Edit awaits destination confirmation. */
import { expect, it, vi } from "vitest";
import { MeridianApiError } from "@/client/api/meridian-error";
import { getThreadSnapshot } from "@/client/api/threads-api";
import {
  bindChatSubmissions,
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

vi.mock("@/client/api/threads-api", async (actual) => ({
  ...(await actual()),
  getThreadSnapshot: vi.fn(),
}));
vi.mock("@/client/chat-submissions/adapters/browser-lock", async () => {
  const { MemorySubmissionLock } = await import("@/client/chat-submissions/adapters/memory-lock");
  return { browserSubmissionLock: new MemorySubmissionLock() };
});
const missing = () =>
  new MeridianApiError(
    {
      code: "thread_not_found",
      message: "Thread not found",
      source: "system",
      retryable: false,
      details: { authenticatedUserId: "o4-writer" },
    },
    404,
  );
it("keeps a new Send on a never-created destination after another tab edits away the last creation record", async () => {
  const account = "o4-writer";
  const creation = {
    title: "Opening",
    workId: null,
    agentName: "General",
    agentSlug: "general",
    agentSelection: { catalogEntryId: "general", definitionRevisionId: "rev" },
  };
  const snapshot = scenarioGate<never>();
  const admission = scenarioGate<never>();
  vi.mocked(getThreadSnapshot).mockImplementation(() => snapshot.promise);
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
  const scenario = new ThreadRunScenario({
    append: () => admission.promise,
    lookup: async () => {
      throw missing();
    },
  });
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
  const unsubscribe = subscribeChatSubmissions(owner.rebuild);
  try {
    // Tab B Edit has durably transferred original words to B's session draft and retired its journal.
    retireChatSubmission(account, "original");
    expect(owner.creationState.kind === "root-unconfirmed").toBe(true);
    expect(getThreadSnapshot).toHaveBeenCalledOnce();
    const projection = serializeComposerDraft(plainComposerDoc("New words from tab A"));
    const source = composerSessionDraft(account, { kind: "chat", id: "thread_1" });
    source.prependSnapshots([projection.draft]);
    expect(
      await owner.submit({
        ...projection,
        submissionId: "new-send",
        acceptedRevision: projection.draft.revision,
      }),
    ).toBe(true);
    console.log(
      "after Send",
      readChatSubmissions(account).map((e) => ({ text: e.text, creation: e.creation })),
      { isCreating: owner.creationState.kind === "root-unconfirmed" },
    );
    expect(readChatSubmissions(account)[0]?.creation).toEqual(creation);
    expect(owner.creationState.kind === "root-unconfirmed").toBe(true);
    source.prependSnapshots([
      serializeComposerDraft(plainComposerDoc("More unsent words in tab A")).draft,
    ]);
    // The retained creation takes create-or-get, not an existing-thread admission.
    await owner.driver.drive("thread_1");
    await new Promise((resolve) => setTimeout(resolve, 30));
    snapshot.reject(missing());
    await new Promise((resolve) => setTimeout(resolve, 30));
    const target = composerSessionDraft(account, { kind: "new-chat", id: "project-1" });
    console.log("after owner-gate 404", {
      records: readChatSubmissions(account),
      source: source.initialDraft,
      target: target.initialDraft,
      dissolved: dissolved.mock.calls.length,
    });
    const retained = [
      ...readChatSubmissions(account).map((e) => e.text),
      source.initialDraft && serializeComposerDraft(source.initialDraft.doc).text,
      target.initialDraft && serializeComposerDraft(target.initialDraft.doc).text,
    ]
      .filter(Boolean)
      .join("\n");
    expect(retained).toContain("New words from tab A");
  } finally {
    life.abort();
    unsubscribe();
    owner.dispose();
    scenario.controller.dispose();
  }
});
