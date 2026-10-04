/** Move identities, receipt counts, and the journal FK lock order against real Postgres. */
import { randomUUID } from "node:crypto";
import { createDb } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextSources,
  documentLinks,
  documents,
  documentYjsUpdates,
  linkRedirects,
  projects,
  users,
} from "@meridian/database/schema";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { deleteDrizzleRows } from "../../../test-support/drizzle-reset.js";
import { createDrizzleCollabPersistence } from "../../collab/adapters/drizzle-journal.js";
import { DrizzleContextTreeMutationStore } from "../adapters/context-fs/drizzle-tree-mutation-store.js";
import { createDrizzleContextOperationReceipts } from "../adapters/context-operation-receipts.js";
import { ContextOperationReceipts } from "../context/context-operation-receipts.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DB suites require DATABASE_URL");
describe("move link redirects", () => {
  const db = createDb(DATABASE_URL, { max: 4 });
  const userId = randomUUID();
  const projectId = randomUUID();
  const sourceId = randomUUID();
  const holder = randomUUID();
  const ch5 = randomUUID();
  const ch6 = randomUUID();
  const tree = new DrizzleContextTreeMutationStore(db);
  beforeEach(async () => {
    await deleteDrizzleRows(db, [users]);
    await db.insert(users).values(conformanceUserValues(userId, "move-links"));
    await db.insert(projects).values({ id: projectId, userId, name: "Links", slug: "links" });
    await db.insert(contextSources).values({
      id: sourceId,
      projectId,
      name: "Manuscript",
      slug: "manuscript",
      scope: "project",
    });
    await db.insert(documents).values([
      { id: holder, contextSourceId: sourceId, name: "holder", extension: "md" },
      { id: ch5, contextSourceId: sourceId, name: "ch5", extension: "md" },
      { id: ch6, contextSourceId: sourceId, name: "ch6", extension: "md" },
    ]);
    await db.insert(documentLinks).values([
      {
        sourceDocumentId: holder,
        href: "ch5",
        targetProjectId: projectId,
        targetKey: "manuscript://ch5",
        occurrences: 2,
      },
      {
        sourceDocumentId: holder,
        href: "ch6.md",
        targetProjectId: projectId,
        targetKey: "manuscript://ch6.md",
        occurrences: 1,
      },
    ]);
  });
  afterAll(() => db.close());
  async function move(from: string, to: string, turnId?: string) {
    const source = await tree.inspect(sourceId, from);
    if (source?.kind !== "file") throw new Error("fixture source missing");
    return tree.commitMove({
      source,
      destinationSourceId: sourceId,
      destinationPath: to,
      expectedTarget: { state: "absent" },
      overwrite: false,
      graduateProvisionalName: true,
      destinationFiletype: "markdown",
      mover: { userId, turnId },
    });
  }
  it("a rename and renumber preserve the targets and persist counts in the receipt, while unchanged spellings write none", async () => {
    const receipts = new ContextOperationReceipts(
      createDrizzleContextOperationReceipts(db, { userId, projectId }),
    );
    const op = randomUUID();
    const result = await receipts.execute(
      op,
      {
        kind: "move",
        sourceUri: "manuscript://ch6.md",
        destinationUri: "manuscript://ch7.md",
        expected: { kind: "file", nodeId: ch6 },
      },
      async () => {
        const moved = await move("ch6.md", "ch7.md");
        return moved.ok
          ? { ok: true, value: { ...moved.value, destinationPath: "ch7.md" } }
          : { ok: false, error: { ...moved.error, uri: "manuscript://ch6.md" } };
      },
    );
    expect(result).toMatchObject({ ok: true, value: { linkUpdate: { links: 1, documents: 1 } } });
    expect(
      await createDrizzleContextOperationReceipts(db, { userId, projectId }).lookup(op),
    ).toMatchObject({ result });
    expect(await move("ch5.md", "ch6.md")).toMatchObject({
      ok: true,
      value: { linkUpdate: { links: 2, documents: 1 } },
    });
    expect(
      await db
        .select({
          href: linkRedirects.href,
          target: linkRedirects.targetDocumentId,
          old: linkRedirects.oldFilename,
        })
        .from(linkRedirects)
        .orderBy(linkRedirects.href),
    ).toEqual([
      { href: "ch5", target: ch5, old: "ch5.md" },
      { href: "ch6.md", target: ch6, old: "ch6.md" },
    ]);
    // The holder stays in the same folder. Relative links keep their exact spelling.
    expect(await move("holder.md", "renamed-holder.md")).toMatchObject({
      ok: true,
      value: { linkUpdate: { links: 0, documents: 0 } },
    });
    expect(await db.select().from(linkRedirects)).toHaveLength(2);
  });
  it("an existing redirect wins over a later insert and keeps the original mover", async () => {
    const originalTurn = randomUUID();
    await move("ch6.md", "ch7.md", originalTurn);
    await move("ch5.md", "ch6.md");
    // ch6.md still indexes its old address; a move of the new occupant must not steal it.
    expect(await move("ch6.md", "ch8.md", randomUUID())).toMatchObject({
      ok: true,
      value: { linkUpdate: { links: 0, documents: 0 } },
    });
    expect(
      await db.select().from(linkRedirects).where(eq(linkRedirects.href, "ch6.md")),
    ).toMatchObject([{ targetDocumentId: ch6, moverUserId: userId, moverTurnId: originalTurn }]);
  });
  it("journal insertion can finish while a move holds the holder row, without deadlock", async () => {
    const journal = createDrizzleCollabPersistence(db);
    await journal.lifecycle.ensureDocument(holder);
    let rowLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      rowLocked = resolve;
    });
    let appended!: () => void;
    const appendDone = new Promise<void>((resolve) => {
      appended = resolve;
    });
    tree.setBeforeDestructiveWrite(async () => {
      rowLocked();
      await appendDone;
    });
    const moveDone = runInDrizzleTransaction(db, async () => {
      await currentDrizzleDb(db).execute(sql`SET LOCAL lock_timeout = '2s'`);
      return move("holder.md", "moved-holder.md");
    });
    const doc = new Y.Doc();
    try {
      await locked;
      await runInDrizzleTransaction(db, async () => {
        await currentDrizzleDb(db).execute(sql`SET LOCAL lock_timeout = '2s'`);
        await journal.journal.append(holder, Y.encodeStateAsUpdate(doc), {
          origin: `human:${userId}`,
          seq: 0,
        });
      });
    } finally {
      appended();
      tree.setBeforeDestructiveWrite(null);
      doc.destroy();
    }
    expect(await moveDone).toMatchObject({ ok: true });
    expect(
      await db.select().from(documentYjsUpdates).where(eq(documentYjsUpdates.documentId, holder)),
    ).toHaveLength(1);
  });
});
