/** Throwaway world: one project, one manuscript source, one documents row for the tree Y.Doc. */
import { randomUUID } from "node:crypto";
import type { ContextSourceId, DocumentId, ProjectId, UserId } from "@meridian/contracts";
import { createDb, type Database } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextSources,
  documents,
  folders,
  projects,
  users,
} from "@meridian/database/schema";
import { sql } from "drizzle-orm";
import { createDrizzleJournal } from "../../adapters/drizzle-journal.js";
import { initializeHead } from "../../adapters/drizzle-document-authority-head.js";
import { runInDrizzleTransaction } from "../../../../shared/drizzle-transaction.js";
import { sourceRoot } from "./tree-log.js";

export type PocWorld = {
  db: Database;
  userId: UserId;
  projectId: ProjectId;
  sourceId: ContextSourceId;
  sourceNode: string;
  treeDocId: DocumentId;
  journal: ReturnType<typeof createDrizzleJournal>;
};

export function openDb(url = process.env.DATABASE_URL): Database {
  if (!url) throw new Error("DATABASE_URL is required");
  return createDb(url, { max: 8 });
}

export async function createWorld(db: Database): Promise<PocWorld> {
  const userId = randomUUID() as UserId;
  const projectId = randomUUID() as ProjectId;
  const sourceId = randomUUID() as ContextSourceId;
  const treeDocId = randomUUID() as DocumentId;
  await db.insert(users).values(conformanceUserValues(userId, `tree-oplog-pg-${userId.slice(0, 8)}`));
  await db.insert(projects).values({
    id: projectId,
    userId,
    name: "Serial",
    slug: `serial-${projectId.slice(0, 8)}`,
  });
  await db.insert(contextSources).values({
    id: sourceId,
    projectId,
    name: "manuscript",
    slug: "manuscript",
    scope: "project",
  });
  // The tree Y.Doc needs a documents.id FK. Hidden so live tree readers skip it.
  await db.insert(documents).values({
    id: treeDocId,
    contextSourceId: sourceId,
    name: "__tree_oplog__",
    extension: "",
    fileType: "markdown",
    hidden: true,
  });
  await initializeHead(db, treeDocId);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS tree_branch_nodes (
      branch_id text NOT NULL,
      node_id uuid NOT NULL,
      kind text NOT NULL,
      parent_id uuid,
      context_source_id uuid NOT NULL,
      name text NOT NULL,
      rank text NOT NULL,
      deleted boolean NOT NULL,
      exists_only_in_draft boolean NOT NULL,
      PRIMARY KEY (branch_id, node_id)
    )`);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS tree_branch_nodes_branch
      ON tree_branch_nodes (branch_id)`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS tree_ops (
      seq bigserial PRIMARY KEY,
      record jsonb NOT NULL
    )`);
  return {
    db,
    userId,
    projectId,
    sourceId,
    sourceNode: sourceRoot(sourceId),
    treeDocId,
    journal: createDrizzleJournal(db),
  };
}

export async function countTreeDocUpdates(db: Database, treeDocId: string): Promise<number> {
  const rows = await db.execute(sql`SELECT count(*)::int AS n FROM document_yjs_updates
    WHERE document_id = ${treeDocId}::uuid`);
  return Number((rows as unknown as Array<{ n: number }>)[0]?.n ?? 0);
}

export async function countLiveNodes(
  db: Database,
  sourceId: string,
  treeDocId: string,
): Promise<{ folders: number; documents: number }> {
  const [f] = (await db.execute(sql`SELECT count(*)::int AS n FROM folders
    WHERE context_source_id = ${sourceId}::uuid`)) as unknown as Array<{ n: number }>;
  const [d] = (await db.execute(sql`SELECT count(*)::int AS n FROM documents
    WHERE context_source_id = ${sourceId}::uuid AND id <> ${treeDocId}::uuid`)) as unknown as Array<{
    n: number;
  }>;
  return { folders: Number(f?.n ?? 0), documents: Number(d?.n ?? 0) };
}

export { runInDrizzleTransaction, documents, folders };
