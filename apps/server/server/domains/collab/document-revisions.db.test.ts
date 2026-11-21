/**
 * Revision identity across live rooms, Work peers, response settlement and rebinding.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - snapshot-derived freshness tokens across content, tree, receipt, peer, and flush boundaries (kb/wiki/architecture/collaboration/draft-store-concurrency.md)
 */

import { renderAgentEditResult, toDocHandle } from "@meridian/agent-edit/integration";
import type { WorkId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { LIVE, type TreeWriter } from "@meridian/project-tree";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  drizzleFileAccess,
  grantInProject,
  type TestDestination,
  testFileGrant,
} from "../../test-support/file-grants.js";
import { treeListOfSource, treeSeeder } from "../../test-support/tree-seed.js";
import { createTestWorkProjectionMutation } from "../../test-support/work-projection.js";
import { createDrizzleLineageScratchLifecycle } from "../context/adapters/lineage-scratch-lifecycle.js";
import { createDocumentRevisions } from "../context/index.js";
import { createLocalFileAccessChanges } from "../file-policy/index.js";
import { createDrizzleProjectWorkRepository } from "../projects/index.js";
import { createDrizzleThreadRepository } from "../threads/adapters/drizzle/thread-repository.js";
import { createDrizzleThreadWorksRepository } from "../threads/adapters/drizzle/thread-works-repository.js";
import { createDrizzleWorkCreates } from "./adapters/drizzle-work-creates.js";
import { scopeDraftPeer } from "./domain/document-link-scope-doors.js";
import { createEffectiveDocumentReader } from "./domain/effective-document-reader.js";
import type { DocumentLinkScopes } from "./domain/ports/document-link-scope.js";
import {
  ALPHA_ID,
  BETA_ID,
  closeDatabase,
  createHarness,
  createTestDatabase,
  PROJECT_ID,
  resetDatabase,
  SOURCE_ID,
  schema,
  THREAD_ID,
  TURN_ID,
  USER_ID,
  WORK_DRAFT_ID,
  WORK_ID,
} from "./test-support/collab-postgres-harness.js";
import { createTestDocumentLinkScopes } from "./test-support/document-link-scopes.js";

/** A live edit of the tree (rename, delete), as a person's would be. */
async function liveEdit(db: Database, edit: (writer: TreeWriter) => unknown) {
  await treeSeeder(db).store.submit({
    lists: [await treeListOfSource(db, SOURCE_ID)],
    make: ([{ writer }]) => edit(writer),
  });
}

/** The grant names this project and its owner, as the file policy would: the read's scope key. */
function inProject<T extends ReturnType<typeof testFileGrant>>(grant: T): T {
  return grantInProject(grant, PROJECT_ID, USER_ID);
}

const identity = (responseId: string) => ({
  modelResponseId: responseId,
  editScopeId: responseId,
});

async function fixture(
  db: Database,
  harnesses: Array<ReturnType<typeof createHarness>>,
  mode: "direct" | "draft",
  options: { links?: DocumentLinkScopes } = {},
) {
  const harness = createHarness(db, options.links ? { links: options.links } : {});
  harnesses.push(harness);
  const f = harness.crossWorkProbeFixture();
  await db
    .update(schema.threads)
    .set({ aiWriteMode: mode })
    .where(eq(schema.threads.id, THREAD_ID));
  await f.persistence.seeds.seedInitialDocument(ALPHA_ID, Y.encodeStateAsUpdate(new Y.Doc()));
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
  // The reads spell from the harness's scope, so their revisions compare with these.
  const links = f.links;
  const effective = scopeDraftPeer(
    createEffectiveDocumentReader({
      blockText: { grepTexts: async () => new Map(), wordCounts: async () => new Map() },
      resolveFiletype: async () => null,
      agentEdit: f.collab.agentEdit(),
      documents: f.runtime.markdownDocuments,
      model: f.runtime.model,
      draftView: f.runtime.draftView,
      codec: f.runtime.codec,
      links,
    }),
    links,
    createDrizzleWorkCreates(db, { documents: f.runtime.markdownDocuments }),
  );
  const revisions = createDocumentRevisions({
    links,
    threads: createDrizzleThreadRepository(db, {
      lineageScratch: createDrizzleLineageScratchLifecycle(db),
    }),
    documents: effective,
    fileAccess: drizzleFileAccess(db),
    readAgentChain: async () => [],
    works: createDrizzleProjectWorkRepository({
      lineageScratch: createDrizzleLineageScratchLifecycle(db),
      db,
      fileAccessChanges: createLocalFileAccessChanges(),
      projectionMutation: createTestWorkProjectionMutation(db),
    }),
    threadWorks: createDrizzleThreadWorksRepository(db),
  });
  const core = f.collab.agentEdit();
  const context = {
    threadId: THREAD_ID,
    sessionId: THREAD_ID,
    turnId: TURN_ID,
    grant: inProject(
      testFileGrant(
        mode === "direct"
          ? { kind: "live" }
          : {
              kind: "draft",
              draftId: WORK_DRAFT_ID,
              owner: { kind: "work", workId: WORK_ID },
              ownerHandle: "atomicity-work",
            },
      ),
    ),
  };
  const read = (responseId?: string, destination?: TestDestination) =>
    core.read(
      { file: "alpha.md", documentId: ALPHA_ID },
      {
        ...context,
        ...(responseId ? { responseIdentity: identity(responseId) } : {}),
        ...(destination ? { grant: inProject(testFileGrant(destination)) } : {}),
      },
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
      { ...context, responseIdentity: identity(responseId) },
    );
    expect(outcome.isError, renderAgentEditResult(outcome.result)).toBe(false);
    return outcome;
  }
  return { ...f, core, read, current, stage, writerDelete, revisions, effective };
}

describe("document revisions (postgres and collab)", () => {
  const db = createTestDatabase();
  const harnesses: Array<ReturnType<typeof createHarness>> = [];
  beforeEach(() => resetDatabase(db));
  afterEach(async () => {
    for (const harness of harnesses.splice(0)) {
      await harness.dispose();
    }
  });
  afterAll(() => closeDatabase(db));

  for (const mode of ["direct", "draft"] as const) {
    it(`a write's receipt and the next read equal current in ${mode}; the earlier read does not`, async () => {
      const f = await fixture(db, harnesses, mode);
      const before = await f.read();
      const written = await f.stage("00000000-0000-4000-8000-000000000892");
      const afterRead = await f.read("00000000-0000-4000-8000-000000000892");
      const revision = written.revision;
      expect(revision).toBe(afterRead.revision);
      expect(revision).toBe(await f.current());
      expect(before.revision).not.toBe(revision);
    });
  }

  it("a pure writer deletion in the Hocuspocus room invalidates a live read", async () => {
    const f = await fixture(db, harnesses, "direct");
    const before = await f.read();
    await f.writerDelete();
    expect(await f.current()).not.toBe(before.revision);
  });

  it("a tree-only move changes the view revision, so compaction does not elide the stale read", async () => {
    const f = await fixture(db, harnesses, "direct", {
      links: createTestDocumentLinkScopes(db, {}),
    });
    const doc = f.hocuspocus.documents.get(ALPHA_ID);
    if (!doc) throw new Error("Fixture live room missing");
    const before = Y.encodeStateVector(doc);
    const documentSchema = buildDocumentSchema();
    const link = documentSchema.marks.link.create({ href: "beta.md", ref: `doc:${BETA_ID}` });
    f.model.insertBlocks(toDocHandle(doc), null, {
      blocks: [documentSchema.node("paragraph", null, [documentSchema.text("Beta", [link])])],
    });
    await f.persistence.journal.append(ALPHA_ID, Y.encodeStateAsUpdate(doc, before), {
      origin: `human:${USER_ID}`,
      seq: 0,
    });
    const shown = await f.current();
    expect(shown).toMatch(/^y2:/);
    expect(await f.current()).toBe(shown);
    // The model's read and the revision-only path agree under real scopes, or
    // compaction would never elide a copy.
    expect((await f.read()).revision).toBe(shown);

    // Nothing in alpha changes; only where its link's target sits.
    await liveEdit(db, (writer) => writer.rename(LIVE, "system", BETA_ID, "gamma"));
    const moved = await f.current();
    expect(moved).not.toBe(shown);
    expect((await f.read()).revision).toBe(moved);

    // A drafted view follows live locations for documents it did not create.
    const view = {
      documentId: ALPHA_ID,
      threadId: THREAD_ID,
      destination: "draft" as const,
      draft: WORK_DRAFT_ID,
    };
    const markdown = await f.effective.readEffectiveMarkdown(view);
    const hashlines = await f.effective.readEffectiveHashlines(view);
    const revision = await f.effective.readEffectiveRevision(view);
    if (!markdown.ok || !hashlines.ok) throw new Error(JSON.stringify({ markdown, hashlines }));
    expect
      .soft(hashlines.value.blocks.map((block) => block.body).join("\n"), "hashlines")
      .toContain("[Beta](gamma)");
    expect.soft(markdown.value.content, "Markdown").toContain("[Beta](gamma)");
    expect
      .soft([markdown.value.revision, revision], "one view")
      .toEqual([hashlines.value.revision, hashlines.value.revision]);
  });

  it("resolves a new Work source after rebind when its text differs", async () => {
    const f = await fixture(db, harnesses, "draft");
    await f.read();
    await f.stage("00000000-0000-4000-8000-000000000894");
    const before = await f.read();
    const workB = "00000000-0000-4000-8000-000000000890" as WorkId;
    await db.insert(schema.works).values({
      id: workB,
      projectId: PROJECT_ID,
      createdByUserId: USER_ID,
      name: "Other draft",
      handle: "w2",
      draftId: "otherdraftw2",
    });
    await createDrizzleThreadWorksRepository(db).rebindPrimary(THREAD_ID, workB);
    expect(await f.current()).not.toBe(before.revision);
    // The thread's grants now name Work B, whose draft holds nothing yet: the read is live (S1).
    const rebound = {
      kind: "draft",
      draftId: "otherdraftw2",
      owner: { kind: "work", workId: workB },
      ownerHandle: "other-draft",
    } as const;
    expect((await f.read(undefined, rebound)).revision).toBe(await f.current());
  });

  it("does not treat a deleted document's still-loaded room as a readable source", async () => {
    const f = await fixture(db, harnesses, "direct");
    expect((await f.read()).revision).toMatch(/^y2:/);
    await liveEdit(db, (writer) => writer.delete(LIVE, "system", ALPHA_ID));
    expect(f.hocuspocus.documents.has(ALPHA_ID)).toBe(true);
    expect(await f.current()).toBeNull();
  });
});
