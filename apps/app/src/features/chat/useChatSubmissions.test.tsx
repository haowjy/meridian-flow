// @vitest-environment jsdom
/** Journal row ownership and Edit's safe transfer boundary. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  bindChatSubmissions,
  type ChatSubmission,
  chatSubmissionStorageKey,
  readChatSubmissions,
  recordChatSubmission,
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
import { clearChatSubmissionRecoverySession, useChatSubmissions } from "./useChatSubmissions";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
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
async function mount(scenario: ThreadRunScenario) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient();
  const dissolved = vi.fn();
  let binding: ReturnType<typeof useChatSubmissions> | undefined;
  function Binding() {
    binding = useChatSubmissions(
      "thread_1",
      "project-1",
      account,
      scenario.controller,
      scenario.store.getState(),
      () => {},
      dissolved,
    );
    return null;
  }
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Binding />
      </QueryClientProvider>,
    ),
  );
  cleanup = async () => {
    await act(async () => root.unmount());
    host.remove();
    scenario.controller.dispose();
    client.clear();
  };
  return {
    read: () => {
      if (!binding) throw new Error("Not mounted");
      return binding;
    },
    dissolved,
  };
}
beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  bindChatSubmissions(account);
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
  clearChatSubmissionRecoverySession();
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
  await act(async () => mounted.read().rowActions(row.id)?.onEdit?.());
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
  await act(async () => mounted.read().rowActions(row.id)?.onEdit?.());
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
  await act(async () => mounted.read().rowActions(row.id)?.onEdit?.());
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
  await act(async () =>
    window.dispatchEvent(new StorageEvent("storage", { key, storageArea: window.localStorage })),
  );
  expect(scenario.turns()).toEqual([]);
  expect(mounted.dissolved).not.toHaveBeenCalled();
});
