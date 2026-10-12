// @vitest-environment jsdom
/** Actual repository owner gate -> HTTP envelope -> bind reconciliation, with stale client identity. */
import { expect, it, vi } from "vitest";
import {
  bindChatSubmissions,
  chatSubmissionStorageKey,
  readChatSubmissions,
} from "@/client/chat-submissions";
import { composerSessionDraft } from "@/client/composer-drafts";
import {
  plainComposerDoc,
  serializeComposerDraft,
} from "@/components/app/composer/composer-document";

vi.mock("@/client/chat-submissions/adapters/browser-lock", async () => {
  const { MemorySubmissionLock } = await import("@/client/chat-submissions/adapters/memory-lock");
  return { browserSubmissionLock: new MemorySubmissionLock() };
});
it("does not discard A live-chat copies when owner gate authenticates the request as B", async () => {
  // Runtime import keeps server-only Nitro declarations outside the app typecheck.
  const serverModule = new URL(
    "../../../../server/server/domains/threads/thread-access.ts",
    import.meta.url,
  ).pathname;
  const { requireThreadOwner } = await import(serverModule);
  vi.stubGlobal("reportError", vi.fn());
  const account = "account-A";
  const threadId = "11111111-1111-4111-8111-111111111111";
  const record = {
    ...serializeComposerDraft(plainComposerDoc("Undelivered A words")),
    recordId: "submission",
    submissionId: "submission",
    threadId,
    projectId: "project-A",
    createdAt: "2026-10-11T00:00:00Z",
    state: "rejected",
  };
  window.localStorage.setItem(
    chatSubmissionStorageKey(account, "submission"),
    JSON.stringify({ version: 2, accountId: account, payload: record }),
  );
  const source = composerSessionDraft(account, { kind: "chat", id: threadId });
  source.prependSnapshots([serializeComposerDraft(plainComposerDoc("Unsent A words")).draft]);
  const thread = { id: threadId, projectId: "project-A", userId: account, deletedAt: null };
  const project = { id: "project-A", userId: account, deletedAt: null };
  let gateCalls = 0;
  vi.stubGlobal("fetch", async () => {
    gateCalls++;
    try {
      // Represents the current shared session cookie. The app loader/journal still say A.
      await requireThreadOwner(
        {
          threads: { findById: async () => thread },
          projects: { findById: async () => project },
        } as unknown as Parameters<typeof requireThreadOwner>[0],
        threadId,
        "account-B" as never,
      );
      throw new Error("B unexpectedly authorized");
    } catch (error) {
      const body = (error as { data?: { __meridianInterruptEnvelope?: unknown } }).data
        ?.__meridianInterruptEnvelope;
      if (!body) throw error;

      return new Response(JSON.stringify(body), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
  });
  try {
    bindChatSubmissions(account);
    await vi.waitFor(() => expect(gateCalls).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(readChatSubmissions(account)).toHaveLength(1);
    expect(source.initialDraft).not.toBeNull();
  } finally {
    vi.unstubAllGlobals();
  }
});
