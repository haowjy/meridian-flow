/** Durable unresolved-submission journal codec + account fence. */
import { describe, expect, it } from "vitest";
import {
  CHAT_SUBMISSIONS_SCHEMA_VERSION,
  CHAT_SUBMISSIONS_STORAGE_PREFIX,
  type ChatSubmissionStorage,
  DeviceChatSubmissionJournal,
  type ExistingThreadChatSubmission,
  type FirstSendChatSubmission,
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

function existingThread(
  overrides: Partial<ExistingThreadChatSubmission> = {},
): ExistingThreadChatSubmission {
  return {
    kind: "existing-thread",
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

function firstSend(overrides: Partial<FirstSendChatSubmission> = {}): FirstSendChatSubmission {
  return {
    kind: "first-send",
    submissionId: "sub-first",
    threadId: "thread-first",
    projectId: "project-1",
    createdAt: "2026-09-22T12:00:00.000Z",
    text: "First",
    activatedSkillSlugs: [],
    title: "First",
    workId: null,
    agentSelection: { catalogEntryId: "entry", definitionRevisionId: "rev" },
    agentName: "General",
    agentSlug: "general",
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
  it("round-trips an entry and exposes it by submission id and thread", () => {
    const { journal } = bound();
    expect(journal.record("account", existingThread())).toBe(true);

    expect(journal.entries()).toEqual([existingThread()]);
    expect(journal.get("sub-1")).toEqual(existingThread());
    expect(journal.forThread("thread-1").map((entry) => entry.submissionId)).toEqual(["sub-1"]);
    expect(journal.forThread("other")).toEqual([]);
  });

  it("upserts one submission id and retires it explicitly", () => {
    const { journal } = bound();
    journal.record("account", existingThread({ text: "one" }));
    journal.record("account", existingThread({ text: "two" }));
    expect(journal.entries()).toHaveLength(1);
    expect(journal.get("sub-1")?.text).toBe("two");

    expect(journal.retire("account", "sub-1")).toBe(true);
    expect(journal.entries()).toEqual([]);
  });

  it("rejects the wrong schema version and corrupt JSON without throwing", () => {
    const { storage, journal } = bound();
    storage.setItem(
      `${CHAT_SUBMISSIONS_STORAGE_PREFIX}account:bad-version`,
      JSON.stringify({ ...existingThread({ submissionId: "bad-version" }), schemaVersion: 99 }),
    );
    storage.setItem(`${CHAT_SUBMISSIONS_STORAGE_PREFIX}account:corrupt`, "{not json");
    storage.setItem(
      `${CHAT_SUBMISSIONS_STORAGE_PREFIX}account:wrong-account`,
      JSON.stringify({
        ...existingThread({ submissionId: "wrong-account" }),
        schemaVersion: CHAT_SUBMISSIONS_SCHEMA_VERSION,
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

  it("returns nothing while unbound", () => {
    const storage = memory();
    const journal = new DeviceChatSubmissionJournal(storage);
    expect(journal.entries()).toEqual([]);
    expect(journal.record("account", existingThread())).toBe(false);
  });

  it("keeps first-send and existing-thread entries in one account record", () => {
    const { journal } = bound();
    journal.record("account", existingThread());
    journal.record("account", firstSend());
    expect(
      journal
        .entries()
        .map((entry) => entry.kind)
        .sort(),
    ).toEqual(["existing-thread", "first-send"]);
  });
});
