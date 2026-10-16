/** Durable unresolved-submission journal codec + account fence. */

import { describe, expect, it } from "vitest";
import { ComposerSessionDraft } from "@/client/composer-drafts";
import {
  plainComposerDoc,
  serializeComposerDraft,
} from "@/components/app/composer/composer-document";
import {
  CHAT_SUBMISSIONS_SCHEMA_VERSION,
  CHAT_SUBMISSIONS_STORAGE_PREFIX,
  type ChatSubmission,
  type ChatSubmissionStorage,
  DeviceChatSubmissionJournal,
  submissionReplayChanged,
} from "./store";

function memory(): ChatSubmissionStorage & { raw(): Map<string, string> } {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    raw: () => values,
  };
}

function existingThread(overrides: Partial<ChatSubmission> = {}): ChatSubmission {
  return {
    recordId: "sub-1",
    submissionId: "sub-1",
    occurrence: { requestId: "sub-1", attempt: 1 },
    threadId: "thread-1",
    projectId: "project-1",
    createdAt: "2026-09-22T12:00:00.000Z",
    seq: 1,
    text: "Hello",
    blocks: [{ type: "text", text: "Hello" }],
    references: [],
    activatedSkillSlugs: [],
    ...overrides,
  };
}

function bound() {
  const storage = memory();
  const journal = new DeviceChatSubmissionJournal(storage);
  journal.setUser("account");
  return { storage, journal };
}

describe("device chat submission journal", () => {
  it("rejects the wrong schema version and corrupt JSON without throwing", () => {
    const { storage, journal } = bound();
    storage.setItem(
      `${CHAT_SUBMISSIONS_STORAGE_PREFIX}account:bad-version`,
      JSON.stringify({
        payload: existingThread({ submissionId: "bad-version" }),
        version: 99,
        accountId: "account",
      }),
    );
    storage.setItem(`${CHAT_SUBMISSIONS_STORAGE_PREFIX}account:corrupt`, "{not json");
    storage.setItem(
      `${CHAT_SUBMISSIONS_STORAGE_PREFIX}account:wrong-account`,
      JSON.stringify({
        payload: existingThread({ submissionId: "wrong-account" }),
        version: CHAT_SUBMISSIONS_SCHEMA_VERSION,
        accountId: "someone-else",
      }),
    );
    expect(journal.entries()).toEqual([]);
  });

  it("never reads another account's keys and preserves them across a bind", () => {
    const storage = memory();
    const journal = new DeviceChatSubmissionJournal(storage);
    journal.setUser("account-a");
    journal.record("account-a", existingThread());
    const epochA = journal.epoch;

    journal.setUser("account-b");
    expect(journal.epoch).toBeGreaterThan(epochA);
    expect(journal.entries()).toEqual([]);

    journal.setUser("account-a");
    expect(journal.entries()).toEqual([existingThread()]);
  });

  it("refuses a write from a stale or foreign bind, and a stale-epoch retire after A→B→A", () => {
    const { journal } = bound();
    journal.record("account", existingThread());
    const epochA = journal.epoch;

    journal.setUser("account-b");
    expect(journal.record("account", existingThread({ recordId: "late" }))).toBe(false);
    expect(journal.retire("account", "sub-1")).toBe(false);
    journal.setUser("account");

    // The live send that started under the first bind must not delete the
    // entry now that the account has re-bound.
    expect(journal.retire("account", "sub-1", epochA)).toBe(false);
    expect(journal.entries()).toHaveLength(1);
    // The returned session retires it for real once it settles.
    expect(journal.retire("account", "sub-1", journal.epoch)).toBe(true);
    expect(journal.entries()).toEqual([]);
  });
});

it("two journal owners preserve the rejected fingerprint while drafts remain tab-local", () => {
  const shared = memory();
  const tabA = memory();
  const tabB = memory();
  const a = new DeviceChatSubmissionJournal(shared);
  const b = new DeviceChatSubmissionJournal(shared);
  a.setUser("account");
  b.setUser("account");
  const draftA = new ComposerSessionDraft("account", { kind: "chat", id: "thread-1" }, () => tabA);
  const draftB = new ComposerSessionDraft("account", { kind: "chat", id: "thread-1" }, () => tabB);
  const rejected = serializeComposerDraft(plainComposerDoc("Rejected words")).draft;
  const next = serializeComposerDraft(plainComposerDoc("New tab B writing"));
  draftA.updateDraft({ text: "Rejected words", snapshot: rejected });
  a.record("account", existingThread({ text: "Rejected words", draft: rejected }));
  draftA.handoffSubmitted(rejected);
  draftB.updateDraft({ text: next.text, snapshot: next.draft });
  const seen = b.get("sub-1") as ChatSubmission;
  draftB.flush();
  expect(b.record("account", { ...seen, state: "rejected" })).toBe(true);
  expect(a.get("sub-1")).toMatchObject({
    state: "rejected",
    draft: rejected,
    text: "Rejected words",
  });
  expect(
    new ComposerSessionDraft("account", { kind: "chat", id: "thread-1" }, () => tabA).initialDraft,
  ).toBeNull();
  expect(
    new ComposerSessionDraft("account", { kind: "chat", id: "thread-1" }, () => tabB).initialDraft
      ?.doc,
  ).toEqual(next.draft.doc);
});

it("rewrites a reminted submission in its stable key, retaining the draft and creation", () => {
  const { journal, storage } = bound();
  const entry = existingThread({
    draft: serializeComposerDraft(plainComposerDoc("Hello")).draft,
    creation: {
      title: "Hello",
      workId: null,
      workAiWriteMode: "direct",
      agentSelection: { catalogEntryId: "entry", definitionRevisionId: "revision" },
      agentName: "Agent",
      agentSlug: "agent",
    },
  });
  journal.record("account", entry);
  journal.record("account", { ...entry, submissionId: "reminted" });
  // One record, and the chat's seq counter.
  expect(storage.length).toBe(2);
  expect(journal.get(entry.recordId)).toEqual({ ...entry, submissionId: "reminted" });
  const retried = { ...entry, occurrence: { requestId: "retry-request", attempt: 2 } };
  journal.record("account", retried);
  const reloaded = new DeviceChatSubmissionJournal(storage);
  reloaded.setUser("account");
  expect(reloaded.get(entry.recordId)?.occurrence).toEqual(retried.occurrence);
  // A new record takes the chat's next place in order; a rewrite keeps its own.
  journal.record("account", { ...entry, recordId: "later", submissionId: "later", seq: 99 });
  journal.record("account", { ...entry, submissionId: "again" });
  expect([entry.recordId, "later"].map((id) => journal.get(id)?.seq)).toEqual([1, 2]);
  // A retired record's number is never reused, even when it was the largest held.
  journal.retire("account", "later");
  journal.record("account", { ...entry, recordId: "third", submissionId: "third" });
  expect(journal.get("third")?.seq).toBe(3);
  // The counter goes with the chat's other state.
  journal.forgetOrder("account", entry.threadId);
  journal.record("account", { ...entry, recordId: "fresh", submissionId: "fresh" });
  expect(journal.get("fresh")?.seq).toBe(4);
});

it("notifies subscribers on writes, retirement and matching cross-tab storage changes", () => {
  const { journal } = bound();
  let notifications = 0;
  const unsubscribe = journal.subscribe(() => {
    notifications += 1;
  });
  const envelope = (entry: ChatSubmission) => JSON.stringify({ payload: entry });
  const before = envelope(existingThread());
  const replay = envelope(existingThread({ occurrence: { requestId: "retry", attempt: 2 } }));
  expect(submissionReplayChanged(before, replay)).toBe(false);
  expect(submissionReplayChanged(null, before)).toBe(true);
  expect(submissionReplayChanged(before, null)).toBe(true);
  expect(submissionReplayChanged(before, envelope(existingThread({ state: "rejected" })))).toBe(
    true,
  );
  journal.record("account", existingThread());
  journal.notifyStorageChange(`${CHAT_SUBMISSIONS_STORAGE_PREFIX}account:another-record`);
  journal.notifyStorageChange(`${CHAT_SUBMISSIONS_STORAGE_PREFIX}account-other:record`);
  journal.retire("account", "sub-1");
  expect(notifications).toBe(3);
  unsubscribe();
  journal.notifyStorageChange(null);
  expect(notifications).toBe(3);
});

it("unavailable record reads retain the last complete snapshot", () => {
  const { storage, journal } = bound();
  journal.record("account", existingThread());
  expect(journal.entries()).toHaveLength(1);
  storage.getItem = () => {
    throw new Error("unavailable");
  };
  expect(journal.snapshot()).toBeNull();
  expect(journal.entries()).toEqual([existingThread()]);
});
