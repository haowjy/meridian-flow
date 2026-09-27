/** Revision identity across live rooms, Work peers, response settlement and rebinding. */

import { toDocHandle } from "@meridian/agent-edit/integration";
import type { ThreadId, WorkId } from "@meridian/contracts/runtime";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createDrizzleDocumentAccess } from "../../lib/document-access.js";
import { createTestWorkProjectionMutation } from "../../test-support/work-projection.js";
import { createDocumentRevisions } from "../context/index.js";
import { createDrizzleProjectWorkRepository } from "../projects/index.js";
import { createDrizzleThreadLock } from "../runtime/adapters/drizzle-thread-lock.js";
import { createDrizzleThreadRepository } from "../threads/adapters/drizzle/thread-repository.js";
import { createDrizzleThreadWorksRepository } from "../threads/adapters/drizzle/thread-works-repository.js";
import { threadExecutionContext } from "../threads/index.js";
import { createEffectiveDocumentReader } from "./domain/effective-document-reader.js";
import {
  ALPHA_ID,
  closeDatabase,
  createHarness,
  db,
  PROJECT_ID,
  resetDatabase,
  schema,
  THREAD_ID,
  TURN_ID,
  USER_ID,
  WORK_ID,
} from "./test-support/change-trail-postgres-harness.js";

beforeEach(resetDatabase);
afterAll(closeDatabase);

async function fixture(mode: "direct" | "draft") {
  const harness = createHarness();
  const f = harness.crossWorkProbeFixture();
  await db.update(schema.works).set({ aiWriteMode: mode }).where(eq(schema.works.id, WORK_ID));
  await f.persistence.lifecycle.ensureDocument(ALPHA_ID);
  await f.liveCoordinator.withDocument(ALPHA_ID, async (doc) => {
    const before = Y.encodeStateVector(doc);
    f.model.insertBlocks(
      toDocHandle(doc),
      null,
      f.markupCodec.parse("Opening paragraph.\n\nSurvivor."),
    );
    await f.persistence.journal.append(ALPHA_ID, Y.encodeStateAsUpdate(doc, before), {
      origin: `human:${USER_ID}`,
      seq: 0,
    });
  });
  const effective = createEffectiveDocumentReader({
    branches: f.branchStore,
    branchCoordinator: f.branchCoordinator,
    branchPulls: f.branchPulls,
    branchPush: f.branchPush,
    liveCoordinator: f.liveCoordinator,
    agentEdit: f.collab.agentEdit(),
    documents: f.runtime.markdownDocuments,
    model: f.runtime.model,
    codec: f.runtime.codec,
  });
  const revisions = createDocumentRevisions({
    threads: createDrizzleThreadRepository(db),
    canAccessDocument: createDrizzleDocumentAccess(db).canAccessDocument,
    documents: effective,
    works: createDrizzleProjectWorkRepository({
      db,
      hasUnreviewedDraft: async () => false,
      projectionMutation: createTestWorkProjectionMutation(db),
    }),
    threadWorks: createDrizzleThreadWorksRepository(db),
  });
  const core = mode === "direct" ? f.runtime.liveUtilityCore : f.collab.agentEdit();
  const context = { threadId: THREAD_ID, sessionId: THREAD_ID, turnId: TURN_ID };
  const read = (responseId?: string) =>
    core.write(
      { command: "read", file: "alpha.md", documentId: ALPHA_ID },
      { ...context, responseId },
    );
  const current = async () =>
    (await revisions.current({ threadId: THREAD_ID, documentIds: [ALPHA_ID] })).get(ALPHA_ID);
  async function writerDelete() {
    // This is the room owned by Hocuspocus, not the delayed markdown projection.
    const doc = f.hocuspocus.documents.get(ALPHA_ID);
    if (!doc) throw new Error("Fixture live room missing");
    const before = Y.encodeStateVector(doc);
    const block = f.model.getBlocks(toDocHandle(doc))[0];
    if (!block) throw new Error("Fixture writer paragraph missing");
    f.model.deleteBlock(toDocHandle(doc), block);
    await f.persistence.journal.append(ALPHA_ID, Y.encodeStateAsUpdate(doc, before), {
      origin: `human:${USER_ID}`,
      seq: 0,
    });
  }
  async function stage(responseId: string) {
    await db.insert(schema.modelResponses).values({
      id: responseId as never,
      turnId: TURN_ID,
      sequence: 0,
      provider: "mock",
      model: "mock",
      requestMessageCount: 0,
      predictedCacheState: "cold",
      predictedCacheReason: "facts_unavailable",
    });

    const outcome = await core.write(
      {
        command: "create",
        file: "alpha.md",
        documentId: ALPHA_ID,
        overwrite: true,
        content: "Agent revision.",
      },
      { ...context, responseId, createdDocument: false },
    );
    expect(outcome.isError, outcome.text).toBe(false);
    return outcome;
  }
  return { ...f, core, read, current, stage, writerDelete, revisions, effective };
}

describe("document revisions (postgres and collab)", () => {
  for (const mode of ["direct", "draft"] as const) {
    it(`read then current are equal in ${mode} execution`, async () => {
      const f = await fixture(mode);
      const read = await f.read();
      expect(read.revision).toMatch(/^y1:/);
      expect(await f.current()).toBe(read.revision);
    });

    it(`response-end write and staged read equal current in ${mode}; the earlier read does not`, async () => {
      const f = await fixture(mode);
      const before = await f.read();
      await f.stage("00000000-0000-4000-8000-000000000892");
      const stagedRead = await f.read("00000000-0000-4000-8000-000000000892");
      const settled = await f.core.commitResponse("00000000-0000-4000-8000-000000000892");
      const revision = settled.documents[0]?.receipts[0]?.revision;
      expect(revision).toBe(stagedRead.revision);
      expect(revision).toBe(await f.current());
      expect(before.revision).not.toBe(revision);
    });
  }

  it("a pure writer deletion in the Hocuspocus room invalidates a live read", async () => {
    const f = await fixture("direct");
    const before = await f.read();
    await f.writerDelete();
    expect(await f.current()).not.toBe(before.revision);
  });

  it("delivers direct-write settlement receipts to the result-rewrite callback", async () => {
    const f = await fixture("direct");
    await f.read();
    const responseId = "00000000-0000-4000-8000-000000000893";
    await f.stage(responseId);
    const receipts: Array<string | null> = [];
    await f.collab.finalizeResponseCommit(
      responseId,
      {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        execution: threadExecutionContext({ id: WORK_ID, slug: null, aiWriteMode: "direct" }),
      },
      async (result) => {
        if (result.status === "committed")
          receipts.push(
            ...result.documents.flatMap((doc) => doc.receipts.map((receipt) => receipt.revision)),
          );
      },
    );
    expect(receipts).toEqual([await f.current()]);
  });

  it("captures the apply token before a writer edit and receipt rewrite", async () => {
    const f = await fixture("direct");
    await f.read();
    await f.stage("00000000-0000-4000-8000-000000000893");
    const original = f.liveCoordinator.withDocument.bind(f.liveCoordinator);
    let injected = false;
    f.liveCoordinator.withDocument = (id, callback, options) =>
      original(
        id,
        async (doc) => {
          const result = await callback(doc);
          if (!injected && result && typeof result === "object" && "revision" in result) {
            injected = true;
            await f.writerDelete();
          }
          return result;
        },
        options,
      );
    const committed = await f.core.commitResponse("00000000-0000-4000-8000-000000000893");
    expect(injected).toBe(true);
    const receipt = committed.documents[0]?.receipts[0];
    expect(receipt?.revision).toMatch(/^y1:/);
    expect(receipt?.revision).not.toBe(await f.current());
  });

  it("pulls a live writer edit synchronously before the Work pull debounce fires", async () => {
    const f = await fixture("draft");
    const before = await f.read();
    await f.writerDelete();
    f.branchPulls.scheduleLivePull(ALPHA_ID);
    expect(await f.current()).not.toBe(before.revision);
    expect((await f.read()).revision).toBe(await f.current());
  });

  it("resolves a new Work source after rebind when its text differs", async () => {
    const f = await fixture("draft");
    await f.read();
    await f.stage("00000000-0000-4000-8000-000000000894");
    await f.core.commitResponse("00000000-0000-4000-8000-000000000894");
    const before = await f.read();
    const workB = "00000000-0000-4000-8000-000000000890" as WorkId;
    await db.insert(schema.works).values({
      id: workB,
      projectId: PROJECT_ID,
      createdByUserId: USER_ID,
      name: "Other draft",
      slug: "other-draft",
      aiWriteMode: "draft",
    });
    await createDrizzleThreadWorksRepository(db).rebindPrimary(THREAD_ID, workB);
    expect(await f.current()).not.toBe(before.revision);
    expect((await f.read()).revision).toBe(await f.current());
  });

  it("does not treat a deleted document's still-loaded room as a readable source", async () => {
    const f = await fixture("direct");
    expect((await f.read()).revision).toMatch(/^y1:/);
    await db
      .update(schema.documents)
      .set({ deletedAt: new Date() })
      .where(eq(schema.documents.id, ALPHA_ID));
    expect(f.hocuspocus.documents.has(ALPHA_ID)).toBe(true);
    expect(await f.current()).toBeNull();
  });

  it("returns null for a source with no Y.Doc", async () => {
    const f = await fixture("direct");
    const binary = "00000000-0000-4000-8000-000000000891";
    const [source] = await db
      .select({ contextSourceId: schema.documents.contextSourceId })
      .from(schema.documents)
      .where(eq(schema.documents.id, ALPHA_ID));
    if (!source) throw new Error("Fixture source missing");
    await db.insert(schema.documents).values({
      id: binary as never,
      contextSourceId: source.contextSourceId,
      name: "unversioned",
      extension: "png",
      fileType: "image",
      mimeType: "image/png",
    });
    const missing = await f.revisions.current({ threadId: THREAD_ID, documentIds: [binary] });
    expect(missing.get(binary)).toBeNull();
  });

  it("can pull and read under the thread mutation lock (third successor attempt)", async () => {
    const f = await fixture("draft");
    const read = await f.read();
    await createDrizzleThreadLock(db).withThreadLock(THREAD_ID as ThreadId, async () => {
      expect(await f.current()).toBe(read.revision);
    });
  });
});
