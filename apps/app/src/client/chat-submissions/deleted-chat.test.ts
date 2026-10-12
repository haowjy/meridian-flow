// @vitest-environment jsdom
/** Attested deletion disposition, distinct from the never-created destination lifecycle. */
import { expect, it } from "vitest";
import { MeridianApiError } from "@/client/api/meridian-error";
import { ComposerSessionDraft } from "@/client/composer-drafts";
import {
  plainComposerDoc,
  serializeComposerDraft,
} from "@/components/app/composer/composer-document";
import { MemorySubmissionLock } from "./adapters/memory-lock";
import { cleanDeletedChat, type DeletedChatPorts, sweepDeletedChats } from "./deleted-chat";
import type { ChatSubmission } from "./store";
import { threadAvailability } from "./thread-availability";

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
