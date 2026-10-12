// @vitest-environment jsdom
/** Attested deletion disposition, distinct from the never-created destination lifecycle. */
import { expect, it, vi } from "vitest";
import { MeridianApiError } from "@/client/api/meridian-error";
import { ComposerSessionDraft } from "@/client/composer-drafts";
import {
  plainComposerDoc,
  serializeComposerDraft,
} from "@/components/app/composer/composer-document";
import { browserSubmissionLock } from "./adapters/browser-lock";
import { MemorySubmissionLock } from "./adapters/memory-lock";
import {
  beginOwnChatDelete,
  cleanDeletedChat,
  cleanDeletedChatsOnBind,
  type DeletedChatPorts,
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
      draft: snapshot("Make the elder colder"),
    },
  ];
  source.prependSnapshots([snapshot("And quieter")]);
  target.prependSnapshots([snapshot("Existing writing")]);
  let visible = true;
  let left: boolean | undefined;
  const ports: DeletedChatPorts = {
    current: () => true,
    records: () => records,
    retire: (id) => {
      records = records.filter((row) => row.recordId !== id);
      return true;
    },
    draft: (_account, scope) => (scope.kind === "chat" ? source : target),
    surfaces: () => [
      {
        visible: () => visible,
        title: () => "Arc 2 notes",
        recordIds: () => new Set(records.map((row) => row.recordId)),
        leave: (moved) => {
          left = moved;
        },
      },
    ],
    lock: new MemorySubmissionLock(),
  };
  return {
    ports,
    source,
    target,
    records: () => records,
    left: () => left,
    hide: () => {
      visible = false;
    },
    snapshot,
    reload: () => new ComposerSessionDraft("owner", { kind: "new-chat", id: "project" }, () => tab),
  };
}
it("moves the shown failed row and box ahead of New chat with a reload-safe note", async () => {
  const f = fixture();
  await cleanDeletedChat("owner", "chat", "project", "deleted", f.ports);
  expect(serializeComposerDraft(f.target.initialDraft?.doc ?? plainComposerDoc("")).text).toBe(
    "Make the elder colder\nAnd quieter\nExisting writing",
  );
  expect(f.target.notices).toEqual([{ threadId: "chat", title: "Arc 2 notes", count: 2 }]);
  expect(f.records()).toEqual([]);
  expect(f.source.initialDraft).toBeNull();
  expect(f.left()).toBe(true);
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
it("off-screen discards without moving or leaving a note", async () => {
  const f = fixture();
  f.hide();
  await cleanDeletedChat("owner", "chat", "project", "deleted", f.ports);
  expect(f.target.notices).toEqual([]);
  expect(serializeComposerDraft(f.target.initialDraft?.doc ?? plainComposerDoc("")).text).toBe(
    "Existing writing",
  );
  expect(f.source.initialDraft).toBeNull();
  expect(f.records()).toEqual([]);
  expect(f.left()).toBe(false);
});
it("own Delete and deleted projects retain nothing and never annotate", async () => {
  for (const reason of ["own-delete", "project-deleted"] as const) {
    const f = fixture();
    await cleanDeletedChat("owner", "chat", "project", reason, f.ports);
    expect(f.records()).toEqual([]);
    expect(f.source.initialDraft).toBeNull();
    expect(f.target.notices).toEqual([]);
    expect(f.left()).toBe(false);
  }
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
    "And quieter\nExisting writing",
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
it.each([
  "unreadable journal",
  "refused destination",
])("retains all words and stays when cleanup has an %s", async (failure) => {
  const f = fixture();
  if (failure === "unreadable journal") f.ports.records = () => null;
  else vi.spyOn(f.target, "prependSnapshots").mockReturnValue(false);
  expect(await cleanDeletedChat("owner", "chat", "project", "deleted", f.ports)).toBe(false);
  expect(f.source.initialDraft).not.toBeNull();
  expect(f.records()).toHaveLength(1);
  expect(f.left()).toBeUndefined();
});
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

it("own DELETE intent wins over a send's deletion response while DELETE is still in flight", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  const { bindChatSubmissions } = await import("./index");
  const { deleteProjectChat } = await import("@/client/query/delete-project-chat");
  const memory = new MemorySubmissionLock();
  const lock = vi.spyOn(browserSubmissionLock, "run").mockImplementation(memory.run.bind(memory));
  bindChatSubmissions("owner", () => true);
  const f = fixture();
  let finishDelete!: () => void;
  deleteApi.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finishDelete = resolve;
      }),
  );
  let answerSend!: () => void;
  const sendResponse = new Promise<void>((resolve) => {
    answerSend = resolve;
  });
  const sending = f.ports.lock.run("owner", "chat", new AbortController().signal, async () => {
    await sendResponse;
    await cleanDeletedChat("owner", "chat", "project", "deleted", f.ports, true);
  });
  const deleting = deleteProjectChat(new QueryClient(), "project", "chat");
  answerSend();
  await sending;
  expect(f.target.notices).toEqual([]);
  expect(serializeComposerDraft(f.target.initialDraft?.doc ?? plainComposerDoc("")).text).toBe(
    "Existing writing",
  );
  expect(f.records()).toEqual([]);
  finishDelete();
  await deleting;
  await new Promise((resolve) => setTimeout(resolve, 0));
  lock.mockRestore();
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
  expect(probe.mock.calls.map(([, id]) => id)).toEqual(["queued"]);
  expect(
    readChatSubmissionSnapshot(account)
      ?.map((row) => row.recordId)
      .sort(),
  ).toEqual(["dock", "queued", "url"]);
  lock.mockRestore();
  probe.mockClear();
});

it("failed own DELETE cancels its disposition, and confirmed cleanup releases it for a restored chat", async () => {
  const { bindChatSubmissions } = await import("./index");
  bindChatSubmissions("owner", () => true);
  const failed = beginOwnChatDelete("owner", "chat");
  failed.cancel();
  const f = fixture();
  await cleanDeletedChat("owner", "chat", "project", "deleted", f.ports);
  expect(f.target.notices).toHaveLength(1);
  f.target.handoff();
  const confirmed = beginOwnChatDelete("owner", "chat");
  confirmed.confirmed();
  await cleanDeletedChat("owner", "chat", "project", "own-delete", f.ports);
  f.source.updateDraft({ text: "Restored writing", snapshot: f.snapshot("Restored writing") });
  await cleanDeletedChat("owner", "chat", "project", "deleted", f.ports);
  expect(serializeComposerDraft(f.target.initialDraft?.doc ?? plainComposerDoc("")).text).toBe(
    "Restored writing",
  );
});
it("own DELETE's intent cannot survive an account rebind epoch", async () => {
  const { bindChatSubmissions } = await import("./index");
  bindChatSubmissions("owner", () => true);
  const own = beginOwnChatDelete("owner", "chat");
  bindChatSubmissions("another-owner", () => true);
  bindChatSubmissions("owner", () => true);
  const f = fixture();
  await cleanDeletedChat("owner", "chat", "project", "deleted", f.ports);
  expect(f.target.notices).toHaveLength(1);
  own.cancel();
});
