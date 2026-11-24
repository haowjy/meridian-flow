/**
 * Revision identity of the Live room across writer edits, tree moves, response settlement and deleted documents.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - snapshot-derived freshness tokens across content, tree, receipt, peer, and flush boundaries (apps/server/server/domains/collab/.context/CONTEXT.md#revision-and-removal)
 */

import { renderAgentEditResult } from "@meridian/agent-edit/integration";
import type { Database } from "@meridian/database";
import { LIVE, type TreeWriter } from "@meridian/project-tree";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { scopeEffectiveReader } from "./domain/document-link-scope-doors.js";
import { createEffectiveDocumentReader } from "./domain/effective-document-reader.js";
import type { DocumentLinkScopes } from "./domain/ports/document-link-scope.js";
import { createWorkCreates } from "./domain/work-creates.js";
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
import { writeLiveMarkdown, writerEdit } from "./test-support/live-room-text.js";

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
  await writeLiveMarkdown(f.rooms, ALPHA_ID, "Opening paragraph.\n\nSurvivor.");
  // The reads spell from the harness's scope, so their revisions compare with these.
  const links = f.links;
  const effective = scopeEffectiveReader(
    createEffectiveDocumentReader({
      blockText: { grepTexts: async () => new Map(), wordCounts: async () => new Map() },
      resolveFiletype: async () => null,
      schema: buildDocumentSchema(),
      documents: f.runtime.markdownDocuments,
      codec: f.runtime.codec,
      links,
    }),
    links,
    createWorkCreates({ documents: f.runtime.markdownDocuments }),
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
    threadWorks: createDrizzleThreadWorksRepository(db, null),
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
  /** The writer deletes the first paragraph in the Live room. */
  const writerDelete = () => writerEdit(f.rooms, ALPHA_ID, (blocks) => blocks.slice(1));
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

  it("a write's receipt and the next read equal current; the earlier read does not", async () => {
    const f = await fixture(db, harnesses, "direct");
    const before = await f.read();
    const written = await f.stage("00000000-0000-4000-8000-000000000892");
    const afterRead = await f.read("00000000-0000-4000-8000-000000000892");
    const revision = written.revision;
    expect(revision).toBe(afterRead.revision);
    expect(revision).toBe(await f.current());
    expect(before.revision).not.toBe(revision);
  });

  it("a pure writer deletion in the Live room invalidates a live read", async () => {
    const f = await fixture(db, harnesses, "direct");
    const before = await f.read();
    await f.writerDelete();
    expect(await f.current()).not.toBe(before.revision);
  });

  it("a tree-only move changes the view revision, so compaction does not elide the stale read", async () => {
    const f = await fixture(db, harnesses, "direct", {
      links: createTestDocumentLinkScopes(db, {}),
    });
    const documentSchema = buildDocumentSchema();
    const link = documentSchema.marks.link.create({ href: "beta.md", ref: `doc:${BETA_ID}` });
    await writerEdit(f.rooms, ALPHA_ID, (blocks) => [
      documentSchema.node("paragraph", null, [documentSchema.text("Beta", [link])]),
      ...blocks,
    ]);
    const shown = await f.current();
    expect(shown).toMatch(/^l1:/);
    expect(await f.current()).toBe(shown);
    // The model's read and the revision-only path agree under real scopes, or
    // compaction would never elide a copy.
    expect((await f.read()).revision).toBe(shown);

    // Nothing in alpha changes; only where its link's target sits.
    await liveEdit(db, (writer) => writer.rename(LIVE, "system", BETA_ID, "gamma"));
    const moved = await f.current();
    expect(moved).not.toBe(shown);
    expect((await f.read()).revision).toBe(moved);
  });

  it("does not treat a deleted document's still-loaded room as a readable source", async () => {
    const f = await fixture(db, harnesses, "direct");
    expect((await f.read()).revision).toMatch(/^l1:/);
    await liveEdit(db, (writer) => writer.delete(LIVE, "system", ALPHA_ID));
    expect(await f.current()).toBeNull();
  });
});
