/** Durable first-send continuity transaction and isolation contracts. */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import {
  plainComposerDoc,
  serializeComposerDraft,
} from "@/components/app/composer/composer-document";
import { FirstSendContinuity, type FirstSendContinuityRecord } from "./first-send-continuity";

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
async function publish(
  continuity: FirstSendContinuity,
  value: Omit<FirstSendContinuityRecord, "creation">,
) {
  let slot = await continuity.readCreation(value.projectId);
  if (!slot.attempt) {
    slot = (
      await continuity.saveCreationDraft(value.projectId, slot.revision, value.envelope.draft)
    ).slot;
    await continuity.beginCreation(value.projectId, slot.revision, {
      attemptId: value.submissionId,
      projectId: value.projectId,
      threadId: value.threadId,
      title: "Opening",
      workId: null,
      agentSlug: "writer",
      submission: value.envelope,
      phase: "creating",
    });
  }
  await continuity.publishCreation(value.projectId, value.submissionId, {
    projectSlug: "serial",
    threadSlug: "opening",
    optimisticUserTurnId: value.optimisticUserTurnId,
  });
  if (value.latestDraft)
    await continuity.saveCreationDraft(
      value.projectId,
      (await continuity.readCreation(value.projectId)).revision,
      value.latestDraft,
    );
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
    await publish(continuity, value);
    const claims = await Promise.all([continuity.claim(value), continuity.claim(value)]);
    expect(claims.filter((claim) => claim?.dispatch)).toHaveLength(1);
    expect(claims.every((claim) => claim?.record.envelope.draft.doc)).toBe(true);
    expect((await continuity.claim(value))?.record.state).toBe("dispatching");
  });

  it("never re-arms a claimed or ambiguous submission when the same key is staged again", async () => {
    const continuity = owner();
    const value = record();
    await publish(continuity, value);
    expect((await continuity.claim(value))?.dispatch).toBe(true);

    await publish(continuity, { ...value, latestDraft: { ...value.envelope.draft, revision: 4 } });
    const dispatching = await continuity.claim(value);
    expect(dispatching).toMatchObject({
      dispatch: false,
      record: { state: "dispatching", latestDraft: { revision: 4 } },
    });

    const ambiguous = record("project-2", "thread-2");
    await publish(continuity, ambiguous);
    await continuity.markAmbiguous(ambiguous);
    await publish(continuity, ambiguous);
    expect(await continuity.claim(ambiguous)).toMatchObject({
      dispatch: false,
      record: { state: "ambiguous" },
    });
  });

  it("keeps only monotonic full snapshots and retains ambiguous state across a new owner", async () => {
    const account = crypto.randomUUID();
    const continuity = owner(account);
    const value = record();
    await publish(continuity, value);
    const newer = { ...value.envelope.draft, revision: 9, selection: { anchor: 2, head: 1 } };
    const before = await continuity.readCreation(value.projectId);
    await continuity.saveCreationDraft(value.projectId, before.revision, newer);
    expect(
      (
        await continuity.saveCreationDraft(value.projectId, before.revision, {
          ...newer,
          revision: 8,
        })
      ).kind,
    ).toBe("conflict");
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
    await publish(first, a);
    await publish(first, b);
    expect(await otherAccount.findForThread(a.projectId, a.threadId)).toBeNull();
    const observed = await first.peek(a);
    if (!observed) throw new Error("Missing admission");
    await first.retire(observed);
    expect(await first.findForThread(a.projectId, a.threadId)).toBeNull();
    expect(await first.findForThread(b.projectId, b.threadId)).not.toBeNull();
  });

  it("rejects and deletes corrupt persisted JSON", async () => {
    const account = crypto.randomUUID();
    const continuity = owner(account);
    const value = record();
    await publish(continuity, value);
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
    const ready = await continuity.publishCreation("project", "attempt", {
      optimisticUserTurnId: "optimistic",
      projectSlug: "serial",
      threadSlug: "opening",
    });
    expect(ready.slot.attempt).toMatchObject({ ...attempt, phase: "ready" });
    expect((await continuity.finishCreation("project", "other")).kind).toBe("conflict");
    const admission = await continuity.peek({
      projectId: "project",
      threadId: "thread",
      submissionId: envelope.submissionId,
    });
    if (!admission) throw new Error("Missing admission");
    await continuity.retire(admission);
    expect(await continuity.readCreation("project")).toMatchObject({
      draft: null,
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
    await continuity.publishCreation(null, "attempt", {
      projectSlug: "new",
      threadSlug: "thread",
      optimisticUserTurnId: "optimistic",
    });
    const admission = await continuity.peek({
      projectId: "new",
      threadId: "thread",
      submissionId: envelope.submissionId,
    });
    if (!admission) throw new Error("Missing admission");
    await continuity.retire(admission);
    expect(await continuity.readCreation(null)).toMatchObject({
      draft: null,
      attempt: null,
    });
  });
});

describe("creation admission transaction", () => {
  it("publishes ready state with its admission and refuses stale retirement after newer typing", async () => {
    const continuity = owner();
    const value = record();
    const saved = await continuity.saveCreationDraft(value.projectId, 0, value.envelope.draft);
    await continuity.beginCreation(value.projectId, saved.slot.revision, {
      attemptId: "attempt",
      projectId: value.projectId,
      threadId: value.threadId,
      title: "Opening",
      workId: null,
      agentSlug: "writer",
      submission: value.envelope,
      phase: "creating",
    });
    await continuity.publishCreation(value.projectId, "attempt", {
      projectSlug: "serial",
      threadSlug: "opening",
      optimisticUserTurnId: value.optimisticUserTurnId,
    });
    const claim = await continuity.findForThread(value.projectId, value.threadId);
    expect(claim?.dispatch).toBe(true);
    expect((await continuity.readCreation(value.projectId)).attempt?.phase).toBe("ready");
    expect((await continuity.finishCreation(value.projectId, "attempt")).kind).toBe("conflict");
    const slot = await continuity.readCreation(value.projectId);
    const later = { ...value.envelope.draft, revision: 10 };
    await continuity.saveCreationDraft(value.projectId, slot.revision, later);
    if (!claim) throw new Error("Missing claim");
    expect(await continuity.retire(claim.record)).toBe(false);
    const current = await continuity.peek(value);
    expect(current?.latestDraft).toEqual(later);
    if (!current) throw new Error("Missing admission");
    expect(await continuity.retire(current)).toBe(true);
    expect(await continuity.peek(value)).toBeNull();
    expect(await continuity.readCreation(value.projectId)).toMatchObject({
      draft: null,
      attempt: null,
    });
  });

  it("does not consume a composer draft when an empty package chat is acknowledged", async () => {
    const continuity = owner();
    const draft = record().envelope.draft;
    const saved = await continuity.saveCreationDraft(null, 0, draft);
    await continuity.beginCreation(null, saved.slot.revision, {
      attemptId: "package",
      projectId: "new",
      threadId: "thread",
      title: "Package",
      workId: null,
      agentSlug: "writer",
      submission: null,
      phase: "creating",
    });
    await continuity.publishCreation(null, "package", { projectSlug: "new", threadSlug: "thread" });
    expect((await continuity.finishCreation(null, "package")).slot).toMatchObject({
      draft,
      attempt: null,
    });
  });
});
