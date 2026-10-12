/** Deleted destinations discard their browser copies, never uncreated writing. */
import { expect, it, vi } from "vitest";
import { MemorySubmissionLock } from "./adapters/memory-lock";
import { forgetCreatedChatCopies, reconcileChatCopies } from "./forget";
import type { ChatSubmission } from "./store";

const entry = (recordId: string, threadId = "gone", state?: "rejected") =>
  ({ recordId, submissionId: `submission-${recordId}`, threadId, state }) as ChatSubmission;
function rig() {
  const records = [entry("pending"), entry("refused", "gone", "rejected"), entry("other", "live")];
  const draft = vi.fn();
  const options = {
    accountId: "account",
    signal: new AbortController().signal,
    current: () => true,
    lock: new MemorySubmissionLock(),
    entries: () => records,
    retire: (id: string) => {
      records.splice(
        records.findIndex((e) => e.recordId === id),
        1,
      );
    },
    forgetDraft: draft,
  };
  return { records, draft, options };
}
it("forgets every state and just the chat draft, under the driver lock", async () => {
  const { records, draft, options } = rig();
  let release!: () => void;
  const send = options.lock.run("account", "gone", options.signal, async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    records.push(entry("late"));
  });
  while (!release) await Promise.resolve();
  const forget = forgetCreatedChatCopies(options, "gone");
  expect(draft).not.toHaveBeenCalled();
  release();
  await send;
  await forget;
  expect(records.map((e) => e.recordId)).toEqual(["other"]);
  expect(draft).toHaveBeenCalledWith("gone");
});
it("never forgets a creation cohort or a stale account bind", async () => {
  const { records, draft, options } = rig();
  const first = records[0];
  if (!first) throw new Error("missing fixture");
  first.creation = {} as ChatSubmission["creation"];
  await forgetCreatedChatCopies(options, "gone");
  expect(records).toHaveLength(3);
  expect(draft).not.toHaveBeenCalled();
  first.creation = undefined;
  await forgetCreatedChatCopies({ ...options, current: () => false }, "gone");
  expect(records).toHaveLength(3);
});
it("reconciles unique unmounted created ids with bounded concurrency, keeping every inconclusive answer", async () => {
  const { records, draft, options } = rig();
  for (const id of ["server", "network", "auth", "timeout", "other404", "mounted", "creation"])
    records.push(entry(id, id));
  const creating = records.at(-1);
  if (!creating) throw new Error("missing fixture");
  creating.creation = {} as ChatSubmission["creation"];
  const probe = vi.fn(async (id: string) =>
    id === "gone" ? ("deleted" as const) : ("unknown" as const),
  );
  await reconcileChatCopies(options, (id) => id === "mounted", probe);
  expect(probe.mock.calls.map((c) => c[0]).sort()).toEqual([
    "auth",
    "gone",
    "live",
    "network",
    "other404",
    "server",
    "timeout",
  ]);
  expect(probe).toHaveBeenCalledWith("gone", "submission-pending");
  expect(records.some((e) => e.threadId === "gone")).toBe(false);
  expect(records).toHaveLength(8);
  expect(draft).toHaveBeenCalledOnce();
});

it("cancels pending draft writes and removes just the specified account/chat scope", async () => {
  const { ComposerSessionDraft } = await import("@/client/composer-drafts");
  const { plainComposerDoc, serializeComposerDraft } = await import(
    "@/components/app/composer/composer-document"
  );
  const saved = new Map<string, string>();
  const storage = {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
    removeItem: (key: string) => saved.delete(key),
  };
  const draft = new ComposerSessionDraft("account", { kind: "chat", id: "gone" }, () => storage);
  const live = new ComposerSessionDraft("account", { kind: "chat", id: "live" }, () => storage);
  const snapshot = {
    revision: 1,
    doc: plainComposerDoc("Unsent"),
    selection: { anchor: 1, head: 1 },
    ownedUploads: [],
  };
  draft.updateDraft({ snapshot, ...serializeComposerDraft(snapshot.doc) });
  live.updateDraft({ snapshot, ...serializeComposerDraft(snapshot.doc) });
  live.flush();
  draft.forget();
  draft.flush();
  expect(saved.has(draft.key)).toBe(false);
  expect(saved.has(live.key)).toBe(true);
  expect(draft.initialDraft).toBeNull();
});

it("retains an empty never-created destination while its mounted owner confirms O4", async () => {
  const { records, draft, options } = rig();
  records.splice(0, 2);
  expect(await forgetCreatedChatCopies({ ...options, created: () => false }, "gone")).toBe(
    "creation",
  );
  expect(draft).not.toHaveBeenCalled();
});

it("runs at most four probes at once and abandons a changed account", async () => {
  const { records, options, draft } = rig();
  for (let i = 0; i < 10; i++) records.push(entry(`record${i}`, `thread${i}`));
  const releases: Array<() => void> = [];
  let current = true;
  let active = 0;
  let max = 0;
  const pending = reconcileChatCopies(
    { ...options, current: () => current },
    () => false,
    async () => {
      active++;
      max = Math.max(max, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
      return "deleted";
    },
  );
  while (releases.length < 4) await Promise.resolve();
  expect(max).toBe(4);
  current = false;
  for (const release of releases) release();
  await pending;
  expect(records).toHaveLength(13);
  expect(draft).not.toHaveBeenCalled();
});

it("distinguishes unavailable storage, creation and stale binds without discarding copies", async () => {
  const { records, options, draft } = rig();
  expect(await forgetCreatedChatCopies({ ...options, entries: () => null }, "gone")).toBe(
    "unavailable",
  );
  expect(await forgetCreatedChatCopies({ ...options, current: () => false }, "gone")).toBe("stale");
  const first = records[0];
  if (!first) throw new Error("missing fixture");
  first.creation = {} as ChatSubmission["creation"];
  expect(await forgetCreatedChatCopies(options, "gone")).toBe("creation");
  expect(records).toHaveLength(3);
  expect(draft).not.toHaveBeenCalled();
});
