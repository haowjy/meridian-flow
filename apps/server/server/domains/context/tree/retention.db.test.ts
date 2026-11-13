/**
 * Retention over Postgres: nothing is released while anything can still bring the document
 * back. A Work's view is kept for every Work that can come back (open, archived, deleted and
 * restorable), so an archived Work's drafted create, an archived Work's text draft of a trashed
 * document and a restorable deleted Work's drafted create all outlive the purge windows, and a
 * whole Discard ends the hold.
 */
import { randomUUID } from "node:crypto";
import type { BranchId, DocumentId, UserId } from "@meridian/contracts";
import { createDb } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  branches,
  branchTreeNodes,
  contextSources,
  documentDrafts,
  documents,
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
import { createTestWorkProjectionMutation } from "../../../test-support/work-projection.js";
import { createDrizzleBranchDiscard } from "../../collab/adapters/drizzle-branch-discard.js";
import {
  createDrizzleBranchStore,
  createDrizzleBranchWriteBoundary,
} from "../../collab/adapters/drizzle-branches.js";
import { createDrizzleDocumentPurgeDisposal } from "../../collab/adapters/drizzle-document-purge-disposal.js";
import { createBranches } from "../../collab/domain/branches.js";
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
  let branchId: BranchId;
  const { draftClose, treeLists } = createTestRemovalDeps(db);
  const seed = treeSeeder(db);
  const trash = createDrizzleDocumentTrash({
    db,
    objectStore: { delete: async () => ({ ok: true as const, value: undefined }) } as never,
    eventSink: { emit() {}, emitBatch() {}, async flush() {} },
    drafts: createDrizzleDocumentPurgeDisposal(db, { close: draftClose }),
    tree: treeLists,
    readMarkdown: async () => "",
  });

  beforeEach(async () => {
    await deleteDrizzleRows(db, [users]);
    await db.insert(users).values(conformanceUserValues(USER, "retention"));
    await db.insert(projects).values({ id: PROJECT, userId: USER, name: "P", slug: "p" });
    await db.insert(contextSources).values({
      id: SOURCE,
      projectId: PROJECT,
      name: "Manuscript",
      slug: "manuscript",
      scope: "project",
    });
    await db
      .insert(works)
      .values({ id: WORK, projectId: PROJECT, createdByUserId: USER, name: "W", handle: "w1" });
    const [branch] = await db
      .insert(branches)
      .values({ projectId: PROJECT, originWorkId: WORK, createdBy: USER })
      .returning({ id: branches.id });
    branchId = (branch as { id: BranchId }).id;
  });

  const branchRow = async (id: string) =>
    (
      await db
        .select()
        .from(branchTreeNodes)
        .where(and(eq(branchTreeNodes.id, id), eq(branchTreeNodes.branchId, branchId)))
    )[0];
  const document = async (id: string) =>
    (await db.select().from(documents).where(eq(documents.id, id)))[0];
  /** A list change that has nothing to do with the Work: it replays every kept view. */
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
      view: { draft: branchId },
      actor: AGENT,
    })) as DocumentId;
    await db.update(works).set({ archivedAt: new Date() }).where(eq(works.id, WORK));
    await unrelatedChange();
    expect(await branchRow(id)).toMatchObject({ existsOnlyInDraft: true });
    expect((await document(id))?.inNoViewSince).toBeNull();

    await backdate("documents", id);
    expect(await trash.purge()).toBe(0);
    await db.update(works).set({ archivedAt: null }).where(eq(works.id, WORK));
    expect((await document(id))?.contentPurgedAt).toBeNull();
    expect(await branchRow(id)).toMatchObject({ existsOnlyInDraft: true });
  });

  it("keeps a trashed document an archived Work still has a text draft of, and the draft", async () => {
    const id = (await seed.document(SOURCE, "live.md")) as DocumentId;
    const draftId = randomUUID();
    await db.insert(documentDrafts).values({
      id: draftId,
      documentId: id,
      kind: "work_draft",
      branchId,
      state: Buffer.alloc(0),
      stateVector: Buffer.alloc(0),
      hasEffect: true,
    });
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
    const [draft] = await db.select().from(documentDrafts).where(eq(documentDrafts.id, draftId));
    expect(draft?.status).toBe("active");
  });

  it("keeps a deleted Work's drafted create while the Work can be restored, and releases it after a whole Discard", async () => {
    const id = (await seed.document(SOURCE, "drafted.md", {
      view: { draft: branchId },
      actor: AGENT,
    })) as DocumentId;
    await db.update(works).set({ deletedAt: new Date() }).where(eq(works.id, WORK));
    await unrelatedChange();
    await backdate("documents", id);
    expect(await trash.purge()).toBe(0);
    expect((await document(id))?.contentPurgedAt).toBeNull();

    // The Work is purged for good: its branch is discarded whole, its view's rows go, and the
    // document is in no view until the window passes.
    const workProjection = createTestWorkProjectionMutation(db);
    const discard = createDrizzleBranchDiscard(db, {
      close: draftClose,
      branches: createBranches({
        store: createDrizzleBranchStore(db),
        boundary: createDrizzleBranchWriteBoundary(db, workProjection),
      }),
      workProjection,
      treeLists,
    });
    await runInDrizzleTransaction(db, () =>
      discard.kernel({ branchId, selection: { kind: "whole" }, userId: USER } as never),
    );
    expect(await branchRow(id)).toBeUndefined();
    await backdate("documents", id);
    expect(await trash.purge()).toBe(1);
    expect((await document(id))?.contentPurgedAt).not.toBeNull();
  });
});
