// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { MeridianApiError } from "@/client/api/meridian-error";
import { browserSubmissionLock } from "./adapters/browser-lock";
import { MemorySubmissionLock } from "./adapters/memory-lock";
import { plainComposerDoc, serializeComposerDraft } from "./composer-document";
import { ComposerSessionDraft } from "./composer-drafts";
import {
  cleanDeletedChat,
  cleanDeletedChatsOnBind,
  type DeletedChatPorts,
  restoreOwnDeletedChatWords,
  sweepDeletedChats,
} from "./deleted-chat";
import type { ChatSubmission } from "./store";
import { threadAvailability } from "./thread-availability";

const deleteApi = vi.hoisted(() => vi.fn());
const probe = vi.hoisted(() => vi.fn());
vi.mock("./thread-availability", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  probeChatDestination: probe,
}));
vi.mock("@/client/api/threads-api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  deleteThread: deleteApi,
}));

function proof(code = "thread_deleted", accountId = "owner", projectDeleted = false) {
  return new MeridianApiError(
    {
      code,
      message: code,
      retryable: false,
      source: "system",
      details: { authenticatedUserId: accountId, projectDeleted },
    },
    404,
  );
}
function fixture() {
  const storage = new Map<string, string>();
  const tab = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
  };
  const source = new ComposerSessionDraft("owner", { kind: "chat", id: "chat" }, () => tab);
  const target = new ComposerSessionDraft("owner", { kind: "new-chat", id: "project" }, () => tab);
  const snapshot = (text: string) => ({
    doc: plainComposerDoc(text),
    revision: 1,
    selection: { anchor: 1, head: 1 },
    ownedUploads: [],
  });
  const envelope = serializeComposerDraft(plainComposerDoc("Make the elder colder"));
  let records: ChatSubmission[] = [
    {
      ...envelope,
      blocks: [...envelope.blocks],
      references: [...envelope.references],
      activatedSkillSlugs: [...envelope.activatedSkillSlugs],
      recordId: "row",
      submissionId: "row",
      threadId: "chat",
      projectId: "project",
      createdAt: "2026-10-11",
      seq: 1,
      draft: snapshot("Make the elder colder"),
    },
  ];
  source.prependSnapshots([snapshot("And quieter")]);
  target.prependSnapshots([snapshot("Existing writing")]);
  let visible = true;
  let verdict: "deleted" | "present" = "deleted";
  const waiting: (() => void)[] = [];
  let left: boolean | undefined;
  let forgotten = 0;
  const ports: DeletedChatPorts = {
    current: () => true,
    records: () => records,
    retire: (id) => {
      records = records.filter((row) => row.recordId !== id);
      return true;
    },
    forgetOrder: () => {
      forgotten += 1;
    },
    draft: (_account, scope) => {
      if (scope.kind === "chat") return source;
      expect(scope.id).toBe("project");
      return target;
    },
    surfaces: () => [
      {
        visible: () => visible,
        leave: (moved) => {
          left = moved;
        },
      },
    ],
    attended: (run) => {
      waiting.push(run);
    },
    probe: async () => verdict,
    lock: new MemorySubmissionLock(),
  };
  return {
    waiting,
    verdict: (next: "deleted" | "present") => {
      verdict = next;
    },
    ports,
    source,
    target,
    records: () => records,
    left: () => left,
    forgotten: () => forgotten,
    hide: () => {
      visible = false;
    },
    snapshot,
    reload: () => new ComposerSessionDraft("owner", { kind: "new-chat", id: "project" }, () => tab),
  };
}
it("moves the shown failed row and box ahead of New chat with a reload-safe note", async () => {
  const f = fixture();
  await cleanDeletedChat(
    "owner",
    "chat",
    "project",
    "deleted",
    f.ports,
    false,
    undefined,
    "Arc 2 notes",
  );
  expect(serializeComposerDraft(f.target.initialDraft?.doc ?? plainComposerDoc("")).text).toBe(
    "Make the elder colder\n\nAnd quieter\n\nExisting writing",
  );
  expect(f.target.notices).toEqual([{ threadId: "chat", title: "Arc 2 notes", count: 2 }]);
  expect(f.records()).toEqual([]);
  expect(f.source.initialDraft).toBeNull();
  expect(f.left()).toBe(true);
  expect(f.forgotten()).toBe(1);
  await cleanDeletedChat("owner", "chat", "project", "deleted", f.ports);
  expect(f.target.notices).toHaveLength(1);
  const reloaded = f.reload();
  expect(reloaded.notices).toEqual(f.target.notices);
  expect(reloaded.hasReceived("row")).toBe(true);
  expect(reloaded.initialDraft).toEqual(f.target.initialDraft);
  const blank = fixture();
  blank.source.updateDraft({
    text: "",
    snapshot: serializeComposerDraft(plainComposerDoc("")).draft,
  });
  await cleanDeletedChat("owner", "chat", "project", "deleted", blank.ports);
  expect(blank.target.notices[0]?.count).toBe(1);
  const empty = fixture();
  for (const row of empty.records()) empty.ports.retire(row.recordId);
  empty.source.updateDraft({
    text: "",
    snapshot: serializeComposerDraft(plainComposerDoc("")).draft,
  });
  await cleanDeletedChat("owner", "chat", "project", "deleted", empty.ports);
  expect(empty.target.notices).toEqual([]);
  expect(empty.left()).toBe(false);
});
it("off-screen, own-delete and deleted-project cleanups move the words too", async () => {
  for (const reason of ["deleted", "own-delete", "project-deleted"] as const) {
    const f = fixture();
    f.hide();
    await cleanDeletedChat(
      "owner",
      "chat",
      "project",
      reason,
      f.ports,
      false,
      undefined,
      "Arc 2 notes",
    );
    expect(serializeComposerDraft(f.target.initialDraft?.doc ?? plainComposerDoc("")).text).toBe(
      "Make the elder colder\n\nAnd quieter\n\nExisting writing",
    );
    expect(f.target.notices).toEqual([
      {
        threadId: "chat",
        title: "Arc 2 notes",
        count: 2,
        ...(reason === "own-delete" ? { own: true } : {}),
      },
    ]);
    expect(f.source.initialDraft).toBeNull();
    expect(f.records()).toEqual([]);
  }
});
it("a chat whose project is unknown keeps its words in place", async () => {
  const f = fixture();
  expect(await cleanDeletedChat("owner", "chat", null, "deleted", f.ports)).toBe(true);
  const g = fixture();
  g.ports.records = () => g.records().map((row) => ({ ...row, projectId: null }));
  expect(await cleanDeletedChat("owner", "chat", null, "deleted", g.ports)).toBe(false);
  expect(g.source.initialDraft).not.toBeNull();
});
it("not-found keeps main's classification and has no deletion disposition", () => {
  expect(threadAvailability(proof("thread_not_found"), "owner")).toBe("not-found");
  expect(threadAvailability(proof("other_error"), "owner")).toBeNull();
});
it("foreign attestation cannot authorize deletion", async () => {
  expect(threadAvailability(proof("thread_deleted", "someone-else"), "owner")).toBeNull();
  expect(threadAvailability(proof("thread_deleted", "owner", true), "owner")).toBe(
    "project-deleted",
  );
  const f = fixture();
  f.ports.current = () => false;
  await cleanDeletedChat("owner", "chat", "project", "own-delete", f.ports);
  expect(f.records()).toHaveLength(1);
  expect(f.source.initialDraft).not.toBeNull();
  expect(f.target.notices).toEqual([]);
  expect(f.left()).toBeUndefined();
});
it("bind sweep bounds concurrency and leaves non-deletion results alone", async () => {
  let active = 0;
  let peak = 0;
  const cleaned: string[] = [];
  await sweepDeletedChats(
    Array.from({ length: 10 }, (_, i) => String(i)),
    () => true,
    async (id, signal) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return id === "0" ? "deleted" : id === "1" ? "project-deleted" : "not-found";
    },
    async (id) => {
      cleaned.push(id);
    },
  );
  expect(peak).toBe(4);
  expect(cleaned.sort()).toEqual(["0", "1"]);
});
it("the accepted two-tab rough edge still moves the other tab's own box", async () => {
  const f = fixture();
  for (const row of f.records()) f.ports.retire(row.recordId);
  await cleanDeletedChat("owner", "chat", "project", "deleted", f.ports);
  expect(serializeComposerDraft(f.target.initialDraft?.doc ?? plainComposerDoc("")).text).toBe(
    "And quieter\n\nExisting writing",
  );
  expect(f.target.notices[0]?.count).toBe(1);
});
it("dismiss and Send clear notices but keep transfer receipts", async () => {
  const f = fixture();
  await cleanDeletedChat("owner", "chat", "project", "deleted", f.ports);
  f.target.dismissNotice("chat");
  expect(f.target.notices).toEqual([]);
  expect(f.target.hasReceived("row")).toBe(true);
  const g = fixture();
  await cleanDeletedChat("owner", "chat", "project", "deleted", g.ports);
  g.target.handoff();
  expect(g.target.notices).toEqual([]);
  expect(g.target.hasReceived("row")).toBe(true);
});

it("restored chat's fresh box moves on a second deletion even at the same revision", async () => {
  const f = fixture();
  await cleanDeletedChat("owner", "chat", "project", "deleted", f.ports);
  f.target.handoff();
  f.source.updateDraft({
    text: "Fresh words",
    snapshot: { ...f.snapshot("Fresh words"), revision: 2 },
  });
  await cleanDeletedChat("owner", "chat", "project", "deleted", f.ports);
  expect(serializeComposerDraft(f.target.initialDraft?.doc ?? plainComposerDoc("")).text).toBe(
    "Fresh words",
  );
});
it.each(["unreadable journal", "refused destination"])(
  "retains all words and stays when cleanup has an %s",
  async (failure) => {
    const f = fixture();
    if (failure === "unreadable journal") f.ports.records = () => null;
    else vi.spyOn(f.target, "prependSnapshots").mockReturnValue(false);
    expect(await cleanDeletedChat("owner", "chat", "project", "deleted", f.ports)).toBe(false);
    expect(f.source.initialDraft).not.toBeNull();
    expect(f.records()).toHaveLength(1);
    expect(f.left()).toBeUndefined();
  },
);
it("bind cleanup rechecks eligibility inside the lock when the chat becomes visible", async () => {
  const f = fixture();
  let eligible = true;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = f.ports.lock.run("owner", "chat", new AbortController().signal, () => gate);
  const cleanup = cleanDeletedChat(
    "owner",
    "chat",
    null,
    "deleted",
    f.ports,
    false,
    () => eligible,
  );
  eligible = false;
  release();
  await held;
  await cleanup;
  expect(f.records()).toHaveLength(1);
  expect(f.source.initialDraft).not.toBeNull();
  expect(f.left()).toBeUndefined();
});

it("bind skips URL and remembered dock chats before panes mount, and rechecks the queued lock", async () => {
  const {
    bindChatSubmissions,
    getChatSubmissionEpoch,
    recordChatSubmission,
    readChatSubmissionSnapshot,
  } = await import("./index");
  const account = "bind-ordering";
  bindChatSubmissions(account, () => true);
  const f = fixture();
  const row = f.records()[0];
  if (!row) throw new Error("Missing fixture");
  for (const id of ["url", "dock", "queued"])
    recordChatSubmission(account, { ...row, recordId: id, threadId: id });
  const epoch = getChatSubmissionEpoch();
  let queuedAddressed = false;
  const addressed = (id: string) => id !== "queued" || queuedAddressed;
  let enter!: () => void;
  let resume!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const lock = vi
    .spyOn(browserSubmissionLock, "run")
    .mockImplementation(async (_account, _id, _signal, operation) => {
      enter();
      await released;
      return operation();
    });
  probe.mockResolvedValue("deleted");
  const sweep = cleanDeletedChatsOnBind(account, epoch, addressed);
  await entered;
  queuedAddressed = true;
  resume();
  await sweep;
  expect(probe.mock.calls.map(([, id]) => id).sort()).toEqual(["dock", "queued", "queued", "url"]);
  expect(
    readChatSubmissionSnapshot(account)
      ?.map((row) => row.recordId)
      .sort(),
  ).toEqual(["dock", "queued", "url"]);
  lock.mockRestore();
  probe.mockClear();
});

it("a tab with no surface claims only after it is attended and the chat is still deleted", async () => {
  const f = fixture();
  f.ports.surfaces = () => [];
  await cleanDeletedChat("owner", "chat", "project", "deleted", f.ports);
  expect(f.waiting).toHaveLength(1);
  expect(f.records()).toHaveLength(1);
  expect(f.source.initialDraft).not.toBeNull();
  f.verdict("present");
  f.waiting[0]?.();
  await new Promise((resolve) => setTimeout(resolve));
  expect(f.records()).toHaveLength(1);
  expect(f.source.initialDraft).not.toBeNull();
  f.verdict("deleted");
  f.waiting[0]?.();
  await vi.waitFor(() => expect(f.records()).toEqual([]));
  expect(serializeComposerDraft(f.target.initialDraft?.doc ?? plainComposerDoc("")).text).toBe(
    "Make the elder colder\n\nAnd quieter\n\nExisting writing",
  );
});

it("Undo of an own delete moves the words back, unless New chat was typed in since", async () => {
  const f = fixture();
  await cleanDeletedChat(
    "owner",
    "chat",
    "project",
    "own-delete",
    f.ports,
    false,
    undefined,
    "Arc 2",
  );
  expect(f.target.notices).toEqual([{ threadId: "chat", title: "Arc 2", count: 2, own: true }]);
  const before = f.target.initialDraft;
  restoreOwnDeletedChatWords("owner", "chat", f.ports.draft);
  expect(serializeComposerDraft(f.target.initialDraft?.doc ?? plainComposerDoc("")).text).toBe(
    "Existing writing",
  );
  expect(f.target.notices).toEqual([]);
  expect(serializeComposerDraft(f.source.initialDraft?.doc ?? plainComposerDoc("")).text).toBe(
    "Make the elder colder\n\nAnd quieter",
  );
  expect(before).not.toBeNull();
  const g = fixture();
  await cleanDeletedChat(
    "owner",
    "chat",
    "project",
    "own-delete",
    g.ports,
    false,
    undefined,
    "Arc 2",
  );
  const moved = g.target.initialDraft;
  if (!moved) throw new Error("Missing move");
  g.target.updateDraft({ text: "More", snapshot: { ...moved, revision: moved.revision + 1 } });
  restoreOwnDeletedChatWords("owner", "chat", g.ports.draft);
  expect(g.target.notices).toHaveLength(1);
  expect(g.source.initialDraft).toBeNull();
  const kept = g.target.initialDraft;
  await cleanDeletedChat("owner", "chat", "project", "own-delete", g.ports);
  expect(g.target.initialDraft).toEqual(kept);
});
