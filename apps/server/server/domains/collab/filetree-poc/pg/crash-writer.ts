/**
 * Child writer for the SIGKILL proof. Appends one journal update inside a
 * transaction, signals ready, then hangs so the parent can kill it before commit.
 *
 * Env: DATABASE_URL, TREE_DOC_ID, READY_PATH
 */
import { writeFileSync } from "node:fs";
import { createDb } from "@meridian/database";
import * as Y from "yjs";
import { createDrizzleJournal } from "../../adapters/drizzle-journal.js";
import { runInDrizzleTransaction } from "../../../../shared/drizzle-transaction.js";

const url = process.env.DATABASE_URL;
const treeDocId = process.env.TREE_DOC_ID;
const readyPath = process.env.READY_PATH;
const mode = process.env.CRASH_MODE ?? "yjs";
if (!url || !treeDocId || !readyPath) {
  console.error("crash-writer: DATABASE_URL, TREE_DOC_ID, READY_PATH required");
  process.exit(2);
}

const db = createDb(url, { max: 1 });

await runInDrizzleTransaction(db, async () => {
  if (mode === "ops") {
    const { sql } = await import("drizzle-orm");
    const { lockDocumentMutation } = await import("../../../../shared/document-mutation-lock.js");
    const { currentDrizzleDb } = await import("../../../../shared/drizzle-transaction.js");
    const tx = currentDrizzleDb(db);
    await lockDocumentMutation(tx, `tree-ops:${process.env.SOURCE_ID ?? "x"}`);
    await tx.execute(
      sql`INSERT INTO tree_ops (record) VALUES ('{"kind":"op","op":{"type":"create","id":"op-crash"}}'::jsonb)`,
    );
  } else {
    const journal = createDrizzleJournal(db);
    const doc = new Y.Doc({ gc: false });
    doc.clientID = 42_042;
    doc.getArray("ops").push([
      {
        type: "create",
        node: "00000000-0000-4000-8000-00000000c015",
        kind: "document",
        name: "crash-uncommitted",
        parent: "root",
        rank: "a0",
        id: "op-crash-uncommitted",
        actor: "user:crash",
        draft: null,
      },
    ]);
    await journal.append(treeDocId, Y.encodeStateAsUpdate(doc), { origin: "system" });
  }
  writeFileSync(readyPath, `${process.pid}\n`, "utf8");
  await new Promise(() => {
    /* hang until SIGKILL */
  });
});
