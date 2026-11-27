// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ThreadStoreProvider, useIsThreadPendingCreation, useThreadActions } from "@/client/stores";
import {
  bindChatSubmissions,
  CHAT_SUBMISSIONS_SCHEMA_VERSION,
  CHAT_SUBMISSIONS_STORAGE_PREFIX,
  type NewChatSubmission,
  recordChatSubmission,
  retireChatSubmission,
} from "./index";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(async () => {
  await vi.dynamicImportSettled();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

it("reads creation synchronously on reload and updates on local writes, storage events and pending flags", async () => {
  window.localStorage.clear();
  bindChatSubmissions("awaiting-account");
  const entry: NewChatSubmission = {
    recordId: "record",
    submissionId: "submission",
    threadId: "thread",
    projectId: "project",
    createdAt: "2026-10-11T12:00:00Z",
    seq: 1,
    text: "Unsent words",
    blocks: [{ type: "text", text: "Unsent words" }],
    references: [],
    activatedSkillSlugs: [],
    creation: {
      title: "Unsent words",
      workId: null,
      draftId: "chatdraft001",
      workAiWriteMode: "direct",
      agentSelection: { slug: "agent", definitionRevisionId: "rev" },
      agentName: "Agent",
      agentSlug: "agent",
      overrides: { model: null, effort: null },
    },
  };
  recordChatSubmission("awaiting-account", entry);
  const seen: boolean[] = [];
  let actions: ReturnType<typeof useThreadActions> | undefined;
  function Reader() {
    seen.push(useIsThreadPendingCreation("thread"));
    actions = useThreadActions();
    return null;
  }
  const client = new QueryClient();
  const node = document.createElement("div");
  const root = createRoot(node);
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <ThreadStoreProvider>
            <Reader />
          </ThreadStoreProvider>
        </QueryClientProvider>,
      ),
    );
    expect(seen[0]).toBe(true);
    await act(async () => {
      retireChatSubmission("awaiting-account", "record");
    });
    expect(seen.at(-1)).toBe(false);
    await act(async () => {
      actions?.markPendingCreation({ threadId: "thread" });
    });
    expect(seen.at(-1)).toBe(true);
    await act(async () => {
      actions?.clearPendingCreation({ threadId: "thread" });
    });
    expect(seen.at(-1)).toBe(false);
    const key = `${CHAT_SUBMISSIONS_STORAGE_PREFIX}awaiting-account:record`;
    await act(async () => {
      window.localStorage.setItem(
        key,
        JSON.stringify({
          version: CHAT_SUBMISSIONS_SCHEMA_VERSION,
          accountId: "awaiting-account",
          payload: entry,
        }),
      );
      window.dispatchEvent(new StorageEvent("storage", { key, storageArea: window.localStorage }));
    });
    expect(seen.at(-1)).toBe(true);
    await act(async () => {
      recordChatSubmission("awaiting-account", { ...entry, creation: undefined });
    });
    expect(seen.at(-1)).toBe(false);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    window.localStorage.clear();
  }
});
