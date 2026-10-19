// Whole Discard revokes Alpha helpers while Beta keeps the response open.
import { randomUUID } from "node:crypto";
import { draftRoomName } from "@meridian/contracts/protocol";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInRootDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { testFileGrant } from "../../../test-support/file-grants.js";
import { setCollabHook } from "../domain/collab-test-hooks.js";
import {
  ALPHA_ID,
  BETA_ID,
  closeDatabase,
  createHarness,
  createTestDatabase,
  PROJECT_ID,
  resetDatabase,
  schema,
  THREAD_ID,
  USER_ID,
} from "../test-support/change-trail-postgres-harness.js";
import {
  createResponse,
  inProject,
  responseContext,
  stageDraft,
} from "../test-support/document-edit-receipt-fixture.js";
import { reviewDriver } from "../test-support/draft-review-requests.js";

describe("response helper revocation (Postgres)", () => {
  const db = createTestDatabase();
  let harness: ReturnType<typeof createHarness>;

  afterEach(() => {
    harness.cancelScheduledPulls();
    harness.destroyWarmState();
  });
  afterAll(() => closeDatabase(db));
  let fixture: ReturnType<ReturnType<typeof createHarness>["crossWorkProbeFixture"]>;
  let draftId: string;
  let responseId: string;
  let context: ReturnType<typeof responseContext>;
  let core: ReturnType<typeof fixture.collab.agentEdit>;
  beforeEach(async () => {
    await resetDatabase(db);
    harness = createHarness(db);
    ({ fixture, draftId } = await stageDraft(db, harness, "red\n\nblue\n\ngreen", "replace", [
      ["red", "gold"],
      ["blue", "azure"],
    ]));
    responseId = await createResponse(db, 2);
    context = responseContext(responseId);
    core = fixture.collab.agentEdit();
    expect(
      await core.write(
        {
          command: "replace",
          file: "alpha.md",
          documentId: ALPHA_ID,
          find: "green",
          content: "lime",
          tool_use_id: "independent-alpha",
        },
        context,
      ),
    ).toMatchObject({ status: "success", phase: "staged" });
    expect(
      await core.write(
        {
          command: "create",
          file: "beta.md",
          documentId: BETA_ID,
          content: "Beta staged.",
          overwrite: true,
          tool_use_id: "independent-beta",
        },
        { ...context, createdDocument: false },
      ),
    ).toMatchObject({ status: "success", phase: "staged" });
  });
  const discard = () => reviewDriver(fixture.collab.draftReview).discardItem(ALPHA_ID);
  const write = (find: string, content: string, tool_use_id: string) =>
    core.write(
      { command: "replace", file: "alpha.md", documentId: ALPHA_ID, find, content, tool_use_id },
      context,
    );
  async function expectBeta() {
    const beta = await fixture.draftStore.resolveWorkDraftForThread(BETA_ID, THREAD_ID);
    try {
      expect(await fixture.draftMarkdown(beta.draftId)).toBe("Beta staged.\n");
    } finally {
    }
  }
  async function expectFreshWrite(content: string) {
    expect(await write("green", content, "fresh-alpha")).toMatchObject({
      status: "success",
      phase: "staged",
    });
    expect(await harness.commit(responseId)).toMatchObject({
      status: "committed",
      documents: expect.arrayContaining([
        expect.objectContaining({ documentId: ALPHA_ID, updateCount: 1 }),
        expect.objectContaining({ documentId: BETA_ID, updateCount: 1 }),
      ]),
    });
    expect(await fixture.draftMarkdown(draftId)).toBe(`red\n\nblue\n\n${content}\n`);
    await expectBeta();
  }
  it("item Discard retires only its Work's peers and staged writes", async () => {
    const workB = randomUUID();
    const threadB = randomUUID();
    const turnB = randomUUID();
    const responseB = randomUUID();
    await db.insert(schema.works).values({
      id: workB as never,
      projectId: PROJECT_ID,
      createdByUserId: USER_ID,
      name: "Other Work",
      slug: "other-work",
    });
    await db.insert(schema.threads).values({
      id: threadB as never,
      rootThreadId: threadB as never,
      projectId: PROJECT_ID,
      createdByUserId: USER_ID,
      title: "Other chat",
      kind: "primary",
      status: "idle",
      aiWriteMode: "draft",
    });
    await db.insert(schema.threadWorks).values({
      threadId: threadB as never,
      workId: workB as never,
      projectId: PROJECT_ID,
      isPrimary: true,
    });
    await db.insert(schema.turns).values({
      id: turnB as never,
      threadId: threadB as never,
      position: 1,
      role: "assistant",
      origin: "assistant",
      status: "complete",
    });
    await db.insert(schema.modelResponses).values({
      id: responseB as never,
      turnId: turnB as never,
      sequence: 1,
      provider: "mock",
      model: "mock",
      requestMessageCount: 1,
      predictedCacheState: "cold",
      predictedCacheReason: "facts_unavailable",
    });
    const contextB = {
      ...context,
      sessionId: threadB,
      threadId: threadB,
      turnId: turnB,
      responseIdentity: { providerResponseId: responseB, editScopeId: responseB },
      grant: inProject(
        testFileGrant({ kind: "draft", workId: workB as never, workSlug: "other-work" }),
      ),
    };
    expect(
      await core.write(
        {
          command: "replace",
          file: "alpha.md",
          documentId: ALPHA_ID,
          find: "green",
          content: "emerald",
          tool_use_id: "other-work-alpha",
        },
        contextB,
      ),
    ).toMatchObject({ status: "success", phase: "staged" });
    const draftB = await fixture.draftStore.resolveWorkDraftForThread(ALPHA_ID, threadB as never);
    const peers = await db
      .select()
      .from(schema.documentDrafts)
      .where(eq(schema.documentDrafts.kind, "thread_peer"));
    const peerA = peers.find((peer) => peer.documentId === ALPHA_ID && peer.threadId === THREAD_ID);
    const peerB = peers.find((peer) => peer.documentId === ALPHA_ID && peer.threadId === threadB);
    if (!peerA || !peerB) throw new Error("Missing the two active Work peers");
    expect(peerB.upstreamDraftId).toBe(draftB.draftId);
    const roomA = draftRoomName(peerA.id, peerA.generation);
    const roomB = draftRoomName(peerB.id, peerB.generation);
    await fixture.hocuspocus.openDirectConnection(roomA);
    await fixture.hocuspocus.openDirectConnection(roomB);
    expect(await discard()).toMatchObject({ status: "discarded" });
    expect(core.hasResponseDocument(responseId, ALPHA_ID)).toBe(false);
    expect(fixture.hocuspocus.documents.has(roomA)).toBe(false);
    expect(fixture.hocuspocus.documents.has(roomB)).toBe(true);
    const [closedA] = await db
      .select()
      .from(schema.documentDrafts)
      .where(eq(schema.documentDrafts.id, peerA.id));
    const [activeB] = await db
      .select()
      .from(schema.documentDrafts)
      .where(eq(schema.documentDrafts.id, peerB.id));
    expect(closedA.status).toBe("closed");
    // Closing a peer is a review-membership input: it moves the peer's revision (§2.5).
    expect(closedA.revision).toBeGreaterThan(peerA.revision);
    expect(activeB.status).toBe("active");
    expect(await core.commitResponse(responseB)).toMatchObject({
      status: "committed",
      documents: expect.arrayContaining([
        expect.objectContaining({ documentId: ALPHA_ID, updateCount: 1 }),
      ]),
    });
    expect(await fixture.draftMarkdown(draftB.draftId)).toBe("red\n\nblue\n\nemerald\n");
    const savedA = await harness.commit(responseId);
    expect(savedA.documents.filter((doc) => doc.updateCount > 0)).toEqual([
      expect.objectContaining({ documentId: BETA_ID, updateCount: 1 }),
    ]);
    expect(await fixture.draftMarkdown(draftId)).toBe("red\n\nblue\n\ngreen\n");
    const freshResponse = await createResponse(db, 3);
    expect(
      await core.write(
        {
          command: "replace",
          file: "alpha.md",
          documentId: ALPHA_ID,
          find: "green",
          content: "olive",
          tool_use_id: "fresh-after-discard",
        },
        responseContext(freshResponse),
      ),
    ).toMatchObject({ status: "success", phase: "staged" });
    expect(await harness.commit(freshResponse)).toMatchObject({ status: "committed" });
    expect(await fixture.draftMarkdown(draftId)).toBe("red\n\nblue\n\nolive\n");
  });
  // Decision D17: Discard's irreversible effects (peer retirement, its room's close, the
  // reply's helper revocation) wait for the ambient root's commit, not a savepoint's release.
  it.each([
    { arm: "item", run: () => discard(), documents: [ALPHA_ID] },
    {
      arm: "whole",
      run: () => reviewDriver(fixture.collab.draftReview).discardAll(),
      documents: [ALPHA_ID, BETA_ID].sort(),
    },
  ])("$arm Discard in an ambient root retires nothing until it commits", async ({
    run,
    documents,
  }) => {
    const peer = await fixture.draftStore.resolveThreadDraft(ALPHA_ID, THREAD_ID);
    const room = draftRoomName(peer.draftId, peer.generation);
    await fixture.hocuspocus.openDirectConnection(room);
    const retired: string[] = [];
    const retire = core.retireThreadPeers;
    core.retireThreadPeers = async (...args) => {
      retired.push(args[0]);
      return retire(...args);
    };
    const effects = async () => ({
      retired: [...retired].sort(),
      roomOpen: fixture.hocuspocus.documents.has(room),
      helper: core.hasResponseDocument(responseId, ALPHA_ID),
      peer: (await fixture.draftStore.getDraft(peer.draftId))?.status,
    });
    const untouched = { retired: [], roomOpen: true, helper: true, peer: "active" };
    try {
      await expect(
        runInRootDrizzleTransaction(db, async () => {
          expect(await run()).toMatchObject({ status: "discarded" });
          expect({ ...(await effects()), peer: "active" }).toEqual(untouched);
          throw new Error("abort root");
        }),
      ).rejects.toThrow("abort root");
      expect(await effects()).toEqual(untouched);
      await runInRootDrizzleTransaction(db, async () => {
        expect(await run()).toMatchObject({ status: "discarded" });
        expect({ ...(await effects()), peer: "active" }).toEqual(untouched);
      });
      // Once per document with a peer, after the commit.
      expect(await effects()).toEqual({
        retired: documents,
        roomOpen: false,
        helper: false,
        peer: "closed",
      });
    } finally {
      core.retireThreadPeers = retire;
    }
  });
  it("delayed retirement preserves a fresh peer's write in the same reply", async () => {
    const oldPeer = await fixture.draftStore.resolveThreadDraft(ALPHA_ID, THREAD_ID);
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const retire = core.retireThreadPeers;
    core.retireThreadPeers = async (...args) => {
      entered();
      await gate;
      return retire(...args);
    };
    const pending = discard();
    try {
      await waiting;
      expect(await fixture.draftStore.getDraft(oldPeer.draftId)).toMatchObject({
        status: "closed",
      });
      expect(await write("green", "olive", "fresh-during-retirement")).toMatchObject({
        status: "success",
        phase: "staged",
      });
      const freshPeer = await fixture.draftStore.resolveThreadDraft(ALPHA_ID, THREAD_ID);
      expect(freshPeer.draftId).not.toBe(oldPeer.draftId);
      const room = draftRoomName(freshPeer.draftId, freshPeer.generation);
      await fixture.hocuspocus.openDirectConnection(room);
      release();
      expect(await pending).toMatchObject({ status: "discarded" });
      expect(fixture.hocuspocus.documents.has(room)).toBe(true);
      expect(core.hasResponseDocument(responseId, ALPHA_ID)).toBe(true);
      const read = await core.read({ file: "alpha.md", documentId: ALPHA_ID }, context);
      expect(read.result.blocks?.flatMap((group) => group.items.map((item) => item.body))).toEqual([
        "red",
        "blue",
        "olive",
      ]);
      expect(await harness.commit(responseId)).toMatchObject({
        status: "committed",
        documents: expect.arrayContaining([
          expect.objectContaining({ documentId: ALPHA_ID, updateCount: 1 }),
          expect.objectContaining({ documentId: BETA_ID, updateCount: 1 }),
        ]),
      });
      expect(await fixture.draftMarkdown(draftId)).toBe("red\n\nblue\n\nolive\n");
      expect(await fixture.draftStore.getDraft(freshPeer.draftId)).toMatchObject({
        status: "active",
      });
    } finally {
      release();
      core.retireThreadPeers = retire;
      await pending;
    }
  });
  it.each([
    { name: "before replay", afterRead: false, fresh: "olive" },
    { name: "after replay", afterRead: true, fresh: "olive" },
  ])("held write is revoked $name", async ({ afterRead, fresh }) => {
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = fixture.draftCoordinator.readDraft.bind(fixture.draftCoordinator);
    let once = true;
    fixture.draftCoordinator.readDraft = async (documentDraft, fn) => {
      const targeted =
        once && documentDraft === draftId && String(fn).includes("listConcurrentJournalRows");
      if (targeted) once = false;
      if (targeted && !afterRead) {
        entered();
        await gate;
      }
      const result = await original(documentDraft, fn);
      if (targeted && afterRead) {
        entered();
        await gate;
      }
      return result;
    };
    try {
      const pending = write("azure", "cobalt", "held-alpha");
      const settled = pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await waiting;
      try {
        expect(await discard()).toMatchObject({ status: "discarded" });
      } finally {
        release();
      }
      expect(await settled).toMatchObject({
        value: {
          status: "invalid_write",
          result: {
            message: expect.stringContaining(
              "Write did not land: the user discarded the text it edited. Re-read and retry.",
            ),
          },
        },
      });
    } finally {
      release();
      fixture.draftCoordinator.readDraft = original;
    }
    expect(await fixture.draftMarkdown(draftId)).toBe("red\n\nblue\n\ngreen\n");
    await expectFreshWrite(fresh);
  });
  it("item Discard rejects a held prepared read without revoking Beta", async () => {
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Pause the read before it reads any draft, so Discard commits ahead of it.
    let once = true;
    const unhook = setCollabHook("draft.beforeAccess", async () => {
      if (once) {
        once = false;
        entered();
        await gate;
      }
    });
    try {
      const pending = core.readRoom({
        documentId: ALPHA_ID,
        threadId: THREAD_ID,
        responseId,
        live: false,
      });
      // Observe rejection before releasing the orphaned read.
      const settled = pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await waiting;
      try {
        expect(await discard()).toMatchObject({ status: "discarded" });
      } finally {
        release();
      }
      const outcome = await settled;
      if ("value" in outcome) outcome.value.dispose();
      expect(outcome).toHaveProperty("error");
    } finally {
      release();
      unhook();
    }
    expect(await fixture.draftMarkdown(draftId)).toBe("red\n\nblue\n\ngreen\n");
    await expectFreshWrite("olive");
  });
});
