import { randomUUID } from "node:crypto";
import type { DocumentId, DraftId, UserId } from "@meridian/contracts";
import { createDb } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextSources,
  documentForks,
  documents,
  draftTreeNodes,
  projects,
  users,
  works,
} from "@meridian/database/schema";
import { LIVE } from "@meridian/project-tree";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { createTestRemovalDeps } from "../../../test-support/document-removal.js";
import { deleteDrizzleRows } from "../../../test-support/drizzle-reset.js";
import { treeListOfSource, treeSeeder } from "../../../test-support/tree-seed.js";
import { defaultDraftOf } from "../../../test-support/work-rows.js";
import { createDrizzleDocumentPurgeDisposal } from "../../collab/adapters/drizzle-document-purge-disposal.js";
import { createDrizzleModelEvidence } from "../../collab/adapters/drizzle-model-evidence.js";
import { discardTreeRecords } from "../../collab/adapters/drizzle-work-tree-discard.js";
import { createDrizzleDocumentTrash } from "./drizzle-document-trash.js";

const enabled = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";

describe.skipIf(!enabled || !process.env.DATABASE_URL)("retention (postgres)", () => {
  const db = createDb(process.env.DATABASE_URL ?? "postgres://unused", { max: 6 });
  afterAll(() => db.close());

  const USER = randomUUID() as UserId;
  const PROJECT = randomUUID();
  const SOURCE = randomUUID();
  const WORK = randomUUID();
  const AGENT = `agent:${randomUUID()}/${randomUUID()}`;
  let draftId: DraftId;
  const { treeLists } = createTestRemovalDeps(db);
  const seed = treeSeeder(db);
  const trash = createDrizzleDocumentTrash({
    db,
    objectStore: { delete: async () => ({ ok: true as const, value: undefined }) } as never,
    eventSink: { emit() {}, emitBatch() {}, async flush() {} },
    purges: createDrizzleDocumentPurgeDisposal(db, { closeRemovedRooms: async () => {} }),
    collab: { endRooms: async () => {}, evidence: createDrizzleModelEvidence(db) },
    tree: treeLists,
  });

  beforeEach(async () => {
    await deleteDrizzleRows(db, [users]);
    await db.insert(users).values(conformanceUserValues(USER, "retention"));
    await db.insert(projects).values({ id: PROJECT, userId: USER, name: "P", slug: "p" });
    await db.insert(contextSources).values({
      id: SOURCE,
      projectId: PROJECT,
      slug: "manuscript",
      scope: "project",
    });
    await db
      .insert(works)
      .values({ id: WORK, projectId: PROJECT, createdByUserId: USER, name: "W", handle: "w1" });
    draftId = await defaultDraftOf(db, WORK);
  });

  const draftRow = async (id: string) =>
    (
      await db
        .select()
        .from(draftTreeNodes)
        .where(and(eq(draftTreeNodes.id, id), eq(draftTreeNodes.draftId, draftId)))
    )[0];
  const document = async (id: string) =>
    (await db.select().from(documents).where(eq(documents.id, id)))[0];
  const unrelatedChange = async () => {
    await seed.document(SOURCE, `other-${randomUUID()}.md`);
  };
  const backdate = (table: "documents" | "tree_nodes", id: string) =>
    db.execute(
      table === "documents"
        ? sql`UPDATE documents SET in_no_view_since = now() - interval '60 days' WHERE id = ${id}::uuid`
        : sql`UPDATE tree_nodes SET trashed_at = now() - interval '60 days' WHERE id = ${id}::uuid`,
    );

  it("keeps an archived Work's drafted create, with its text, through an unrelated change and the window", async () => {
    const id = (await seed.document(SOURCE, "drafted.md", {
      view: { draft: draftId },
      actor: AGENT,
    })) as DocumentId;
    await db.update(works).set({ archivedAt: new Date() }).where(eq(works.id, WORK));
    await unrelatedChange();
    expect(await draftRow(id)).toMatchObject({ existsOnlyInDraft: true });
    expect((await document(id))?.inNoViewSince).toBeNull();

    await backdate("documents", id);
    expect(await trash.purge()).toBe(0);
    await db.update(works).set({ archivedAt: null }).where(eq(works.id, WORK));
    expect((await document(id))?.contentPurgedAt).toBeNull();
    expect(await draftRow(id)).toMatchObject({ existsOnlyInDraft: true });
  });

  it("keeps a trashed document an archived Work still has a pending fork of", async () => {
    const id = (await seed.document(SOURCE, "live.md")) as DocumentId;
    await db.insert(documentForks).values({ draftId, documentId: id, pending: true });
    await db.update(works).set({ archivedAt: new Date() }).where(eq(works.id, WORK));
    await treeLists.submit({
      lists: [await treeListOfSource(db, SOURCE)],
      make: ([{ writer }]) => {
        writer.delete(LIVE, "system", id);
      },
    });
    expect((await trash.list(PROJECT as never)).map((entry) => entry.retention.kind)).toEqual([
      "held",
    ]);

    await backdate("tree_nodes", id);
    expect(await trash.purge()).toBe(0);
    expect((await document(id))?.contentPurgedAt).toBeNull();
  });

  it("keeps a deleted Work's drafted create while the Work can be restored, and releases it after a whole Discard", async () => {
    const id = (await seed.document(SOURCE, "drafted.md", {
      view: { draft: draftId },
      actor: AGENT,
    })) as DocumentId;
    await db.update(works).set({ deletedAt: new Date() }).where(eq(works.id, WORK));
    await unrelatedChange();
    await backdate("documents", id);
    expect(await trash.purge()).toBe(0);
    expect((await document(id))?.contentPurgedAt).toBeNull();

    await runInDrizzleTransaction(db, () =>
      discardTreeRecords(db, { treeLists }, { draftId, userId: USER, commandId: randomUUID() }),
    );
    expect(await draftRow(id)).toBeUndefined();
    await backdate("documents", id);
    expect(await trash.purge()).toBe(1);
    expect((await document(id))?.contentPurgedAt).not.toBeNull();
  });
});
