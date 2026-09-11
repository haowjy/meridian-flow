/** Durable first-send continuity transaction and isolation contracts. */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import {
  plainComposerDoc,
  serializeComposerDraft,
} from "@/components/app/composer/composer-document";
import { FirstSendContinuity } from "./first-send-continuity";

const databases: string[] = [];
function owner(account: string = crypto.randomUUID()) {
  databases.push(`meridian-first-send-${encodeURIComponent(account)}`);
  return new FirstSendContinuity(account);
}
function record(projectId = "project-1", threadId = "thread-1") {
  const envelope = serializeComposerDraft(plainComposerDoc("Opening"), 3, { anchor: 4, head: 2 });
  return {
    projectId,
    threadId,
    submissionId: envelope.submissionId,
    envelope,
    latestDraft: null,
    optimisticUserTurnId: "optimistic-1",
    state: "ready" as const,
  };
}
afterEach(async () => {
  await Promise.all(
    databases.splice(0).map(
      (name) =>
        new Promise<void>((resolve) => {
          const request = indexedDB.deleteDatabase(name);
          request.onsuccess = request.onerror = request.onblocked = () => resolve();
        }),
    ),
  );
});

describe("FirstSendContinuity", () => {
  it("stages and atomically gives exactly one claimant dispatch authority without deleting", async () => {
    const continuity = owner();
    const value = record();
    await continuity.stage(value);
    const claims = await Promise.all([continuity.claim(value), continuity.claim(value)]);
    expect(claims.filter((claim) => claim?.dispatch)).toHaveLength(1);
    expect(claims.every((claim) => claim?.record.envelope.draft.doc)).toBe(true);
    expect((await continuity.claim(value))?.record.state).toBe("dispatching");
  });

  it("never re-arms a claimed or ambiguous submission when the same key is staged again", async () => {
    const continuity = owner();
    const value = record();
    await continuity.stage(value);
    expect((await continuity.claim(value))?.dispatch).toBe(true);

    await continuity.stage({ ...value, latestDraft: { ...value.envelope.draft, revision: 4 } });
    const dispatching = await continuity.claim(value);
    expect(dispatching).toMatchObject({
      dispatch: false,
      record: { state: "dispatching", latestDraft: { revision: 4 } },
    });

    const ambiguous = record("project-2", "thread-2");
    await continuity.stage(ambiguous);
    await continuity.markAmbiguous(ambiguous);
    await continuity.stage(ambiguous);
    expect(await continuity.claim(ambiguous)).toMatchObject({
      dispatch: false,
      record: { state: "ambiguous" },
    });
  });

  it("keeps only monotonic full snapshots and retains ambiguous state across a new owner", async () => {
    const account = crypto.randomUUID();
    const continuity = owner(account);
    const value = record();
    await continuity.stage(value);
    const newer = { ...value.envelope.draft, revision: 9, selection: { anchor: 2, head: 1 } };
    await continuity.updateLatest(value, newer);
    await continuity.updateLatest(value, { ...newer, revision: 8 });
    await continuity.markAmbiguous(value);
    const reloaded = new FirstSendContinuity(account);
    const claim = await reloaded.findForThread(value.projectId, value.threadId);
    expect(claim).toMatchObject({
      dispatch: false,
      record: { state: "ambiguous", latestDraft: newer },
    });
  });

  it("isolates account, project, thread, and submission and removes only the exact key", async () => {
    const first = owner("account-a");
    const otherAccount = owner("account-b");
    const a = record("project-a", "thread-a");
    const b = record("project-b", "thread-b");
    await first.stage(a);
    await first.stage(b);
    expect(await otherAccount.findForThread(a.projectId, a.threadId)).toBeNull();
    await first.remove(a);
    expect(await first.findForThread(a.projectId, a.threadId)).toBeNull();
    expect(await first.findForThread(b.projectId, b.threadId)).not.toBeNull();
  });

  it("rejects and deletes corrupt persisted JSON", async () => {
    const account = crypto.randomUUID();
    const continuity = owner(account);
    const value = record();
    await continuity.stage(value);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const opened = indexedDB.open(`meridian-first-send-${encodeURIComponent(account)}`);
      opened.onsuccess = () => resolve(opened.result);
      opened.onerror = () => reject(opened.error);
    });
    const tx = database.transaction("continuity", "readwrite");
    tx.objectStore("continuity").put(
      { ...value, envelope: { submissionId: value.submissionId } },
      `${value.projectId}\0${value.threadId}\0${value.submissionId}`,
    );
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
    });
    expect(await continuity.claim(value)).toBeNull();
    database.close();
  });
});

describe("single creation slot", () => {
  it("rejects a stale tab write and returns the authoritative draft", async () => {
    const account = crypto.randomUUID();
    const a = owner(account);
    const b = new FirstSendContinuity(account);
    const first = record().envelope.draft;
    expect((await a.saveCreationDraft("project", 0, first)).kind).toBe("saved");
    const stale = await b.saveCreationDraft("project", 0, { ...first, revision: 4 });
    expect(stale).toMatchObject({ kind: "conflict", slot: { revision: 1, draft: first } });
    expect((await a.readCreation(null)).draft).toBeNull();
    expect((await owner().readCreation("project")).draft).toBeNull();
  });

  it("reserves one immutable attempt and late acknowledgement preserves newer typing", async () => {
    const continuity = owner();
    const envelope = record().envelope;
    const saved = await continuity.saveCreationDraft("project", 0, envelope.draft);
    const attempt = {
      attemptId: "attempt",
      projectId: "project",
      threadId: "thread",
      title: "Opening",
      workId: null,
      agentSlug: "writer",
      submission: envelope,
      phase: "creating" as const,
    };
    const claims = await Promise.all([
      continuity.beginCreation("project", saved.slot.revision, attempt),
      continuity.beginCreation("project", saved.slot.revision, { ...attempt, attemptId: "other" }),
    ]);
    expect(claims.filter((value) => value.kind === "saved")).toHaveLength(1);
    const reserved = await continuity.readCreation("project");
    const later = { ...envelope.draft, revision: 4 };
    await continuity.saveCreationDraft("project", reserved.revision, later);
    const ready = await continuity.settleCreation("project", "attempt", {
      phase: "ready",
      projectSlug: "serial",
      threadSlug: "opening",
    });
    expect(ready.slot.attempt).toMatchObject({ ...attempt, phase: "ready" });
    expect((await continuity.finishCreation("project", "other")).kind).toBe("conflict");
    expect((await continuity.finishCreation("project", "attempt")).slot).toMatchObject({
      draft: later,
      attempt: null,
    });
  });

  it("clears only an acknowledged unchanged draft, and discard keeps an uncertain attempt", async () => {
    const continuity = owner();
    const envelope = record().envelope;
    const saved = await continuity.saveCreationDraft(null, 0, envelope.draft);
    const attempt = {
      attemptId: "attempt",
      projectId: "new",
      threadId: "thread",
      title: "Opening",
      workId: null,
      agentSlug: "writer",
      submission: envelope,
      phase: "ambiguous" as const,
    };
    const begun = await continuity.beginCreation(null, saved.slot.revision, attempt);
    const discarded = await continuity.saveCreationDraft(null, begun.slot.revision, null);
    expect(discarded.slot.attempt?.attemptId).toBe("attempt");
    expect((await continuity.finishCreation(null, "attempt")).kind).toBe("conflict");
    await continuity.settleCreation(null, "attempt", { phase: "ready" });
    expect((await continuity.finishCreation(null, "attempt")).slot).toMatchObject({
      draft: null,
      attempt: null,
    });
  });
});
