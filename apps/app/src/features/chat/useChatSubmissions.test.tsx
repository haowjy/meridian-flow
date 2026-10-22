// @vitest-environment jsdom
/** Journal row ownership and Edit's safe transfer boundary. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  bindChatSubmissions,
  type ChatSubmission,
  readChatSubmissions,
  recordChatSubmission,
} from "@/client/chat-submissions";
import { MemorySubmissionLock } from "@/client/chat-submissions/adapters/memory-lock";
import { composerSessionDraft } from "@/client/composer-drafts";
import { scenarioGate, ThreadRunScenario } from "@/client/copilot/test-support/ThreadRunScenario";
import {
  plainComposerDoc,
  serializeComposerDraft,
} from "@/components/app/composer/composer-document";
import { useChatSubmissions } from "./useChatSubmissions";

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
    seq: id === "one" ? 1 : 2,
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

it("subscribes to journal changes and cancels its own pending recovery on unmount", async () => {
  const gate = scenarioGate<never>();
  const scenario = new ThreadRunScenario({ lookup: () => gate.promise });
  const mounted = await mount(scenario);
  await act(async () => {
    recordChatSubmission(account, { ...entry(), state: undefined });
  });
  const row = scenario.turns()[0];
  if (!row) throw new Error("No subscribed row");
  expect(mounted.read().presentation?.get(row.id)).toBeUndefined();
  await act(async () => window.dispatchEvent(new Event("online")));
  await vi.waitFor(() => expect(scenario.lookupRequests).toHaveLength(1));
  await cleanup?.();
  cleanup = undefined;
  expect(readChatSubmissions(account)).toHaveLength(1);
});
