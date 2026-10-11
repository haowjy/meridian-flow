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
    threadId: "thread-1",
    projectId: "project-1",
    createdAt: "2026-09-22T12:00:00.000Z",
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

  it("refuses a write from a stale or foreign bind", () => {
    const { journal } = bound();
    journal.setUser("account-b");
    expect(journal.record("account", existingThread())).toBe(false);
    expect(journal.retire("account", "sub-1")).toBe(false);
    expect(journal.entries()).toEqual([]);
  });

  it("refuses a stale-epoch retire after an A→B→A bind", () => {
    const { journal } = bound();
    journal.record("account", existingThread());
    const epochA = journal.epoch;

    journal.setUser("account-b");
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
  expect(draftB.restoreRejected(rejected)).toBe(false);
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
      agentSelection: { catalogEntryId: "entry", definitionRevisionId: "revision" },
      agentName: "Agent",
      agentSlug: "agent",
    },
  });
  journal.record("account", entry);
  journal.record("account", { ...entry, submissionId: "reminted" });
  expect(storage.length).toBe(1);
  expect(journal.get(entry.recordId)).toEqual({ ...entry, submissionId: "reminted" });
});

it("rewrites only the bound account's v1 words before deleting its old keys", () => {
  const storage = memory();
  const legacy = {
    ...existingThread(),
    kind: "first-send",
    title: "Hello",
    workId: null,
    agentSelection: { catalogEntryId: "entry", definitionRevisionId: "revision" },
    agentName: "Agent",
    agentSlug: "agent",
  };
  for (const accountId of ["account", "account-other"]) {
    storage.setItem(
      `meridian:chat-submissions:v1:${accountId}:sub-1`,
      JSON.stringify({ version: 1, accountId, payload: legacy }),
    );
  }
  const journal = new DeviceChatSubmissionJournal(storage);
  journal.setUser("account");
  expect(journal.get("sub-1")).toMatchObject({
    recordId: "sub-1",
    submissionId: "sub-1",
    creation: { title: "Hello" },
  });
  expect(storage.getItem("meridian:chat-submissions:v1:account:sub-1")).toBeNull();
  expect(storage.getItem("meridian:chat-submissions:v1:account-other:sub-1")).not.toBeNull();
  journal.record("account", { ...journal.get("sub-1")!, submissionId: "reminted" });
  storage.setItem(
    "meridian:chat-submissions:v1:account:sub-1",
    JSON.stringify({ version: 1, accountId: "account", payload: legacy }),
  );
  journal.setUser("account-other");
  journal.setUser("account");
  expect(journal.get("sub-1")?.submissionId).toBe("reminted");
});
