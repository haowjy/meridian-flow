// @vitest-environment jsdom
/** Awaiting-creation reads the journal before effects and observes both ownership sources. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useContextCatalogViews } from "@/client/query/useContextCatalog";
import { ThreadStoreProvider, useIsThreadPendingCreation, useThreadActions } from "@/client/stores";
import { AccountResourceReplica } from "@/core/resources/account-resource-replica";
import { AccountFeatureTestProvider } from "@/test-support/account-feature-provider";
import {
  bindChatSubmissions,
  CHAT_SUBMISSIONS_STORAGE_PREFIX,
  type ChatSubmission,
  recordChatSubmission,
  retireChatSubmission,
} from "./index";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// bindChatSubmissions starts an unawaited deleted-chat sweep behind a dynamic import; let it
// settle inside its own test so it never rejects into the next one.
afterEach(async () => {
  await vi.dynamicImportSettled();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

it("holds only the lineage catalog read while its chat is pending creation", async () => {
  window.localStorage.clear();
  bindChatSubmissions("catalog-account");
  recordChatSubmission("catalog-account", {
    recordId: "record",
    submissionId: "submission",
    threadId: "thread",
    projectId: "project",
    createdAt: "2026-10-11T12:00:00Z",
    text: "Words",
    blocks: [{ type: "text", text: "Words" }],
    references: [],
    activatedSkillSlugs: [],
    creation: {
      title: "Words",
      workId: null,
      agentSelection: { catalogEntryId: "agent", definitionRevisionId: "revision" },
      agentName: "Agent",
      agentSlug: "agent",
    },
  });
  const acquired: string[] = [];
  const spy = vi
    .spyOn(AccountResourceReplica.prototype, "acquireCatalog")
    .mockImplementation((_projectId, scope) => {
      acquired.push(scope.kind);
      return new Promise(() => undefined);
    });
  const client = new QueryClient();
  const root = createRoot(document.createElement("div"));
  function Reader() {
    useContextCatalogViews("project", ["manuscript", "user", "scratch"], {
      rootThreadId: "thread",
    });
    return null;
  }
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <AccountFeatureTestProvider accountId="catalog-account">
            <ThreadStoreProvider now={0}>
              <Reader />
            </ThreadStoreProvider>
          </AccountFeatureTestProvider>
        </QueryClientProvider>,
      ),
    );
    expect([...acquired].sort()).toEqual(["project", "user"]);
    await act(async () => retireChatSubmission("catalog-account", "record"));
    expect([...acquired].sort()).toEqual(["lineage", "project", "user"]);
  } finally {
    await act(async () => root.unmount());
    spy.mockRestore();
    client.clear();
    window.localStorage.clear();
  }
});

it("reads creation synchronously on reload and updates on local writes, storage events and pending flags", async () => {
  window.localStorage.clear();
  bindChatSubmissions("awaiting-account");
  const entry: ChatSubmission = {
    recordId: "record",
    submissionId: "submission",
    threadId: "thread",
    projectId: "project",
    createdAt: "2026-10-11T12:00:00Z",
    text: "Unsent words",
    blocks: [{ type: "text", text: "Unsent words" }],
    references: [],
    activatedSkillSlugs: [],
    creation: {
      title: "Unsent words",
      workId: null,
      agentSelection: { catalogEntryId: "agent", definitionRevisionId: "revision" },
      agentName: "Agent",
      agentSlug: "agent",
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
          <ThreadStoreProvider now={0}>
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
        JSON.stringify({ version: 2, accountId: "awaiting-account", payload: entry }),
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
