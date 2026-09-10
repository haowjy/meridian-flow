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
      const opened = indexedDB.open(`meridian-first-send-${encodeURIComponent(account)}`, 1);
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
