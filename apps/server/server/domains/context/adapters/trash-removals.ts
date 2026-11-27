import type { DocumentId, UserId } from "@meridian/contracts";
import type { DocumentRemovalRecord } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { documents, threads, treeNodes, users } from "@meridian/database/schema";
import { and, inArray, isNotNull } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { isUuid } from "../../../shared/uuid.js";
import type { DocumentRemovals } from "../ports/document-removal.js";
import { parseActor } from "./context-fs/tree-writes.js";

type Actor = DocumentRemovalRecord["actor"];

export async function trashActorsOf(
  db: Database,
  authors: Iterable<string | null>,
): Promise<(by: string | null) => Actor> {
  const tx = currentDrizzleDb(db);
  const userIds = new Set<string>();
  const chatIds = new Set<string>();
  for (const by of authors) {
    const who = parseActor(by);
    if (who?.kind === "user" && isUuid(who.userId)) userIds.add(who.userId);
    if (who?.kind === "agent" && isUuid(who.chatId)) chatIds.add(who.chatId);
  }
  const names = new Map(
    userIds.size === 0
      ? []
      : (
          await tx
            .select({ id: users.id, name: users.name })
            .from(users)
            .where(inArray(users.id, [...userIds]))
        ).map((row) => [row.id, row.name]),
  );
  const titles = new Map(
    chatIds.size === 0
      ? []
      : (
          await tx
            .select({ id: threads.id, title: threads.title })
            .from(threads)
            .where(inArray(threads.id, [...chatIds]))
        ).map((row) => [row.id, row.title]),
  );
  return (by) => {
    const who = parseActor(by);
    if (who?.kind === "user" && names.has(who.userId))
      return {
        kind: "user",
        userId: who.userId as UserId,
        displayName: names.get(who.userId) ?? null,
      };
    if (who?.kind === "agent" && titles.has(who.chatId))
      return {
        kind: "agent",
        chatTitle: titles.get(who.chatId)?.trim() || null,
        chatId: who.chatId,
      };
    return null;
  };
}

export function createTrashRemovals(db: Database): DocumentRemovals {
  return {
    actors: (authors) => trashActorsOf(db, authors),
    async lookup(documentIds) {
      const out = new Map<DocumentId, DocumentRemovalRecord>();
      if (documentIds.length === 0) return out;
      const tx = currentDrizzleDb(db);
      const rows = await tx
        .select({ id: treeNodes.id, trashedAt: treeNodes.trashedAt, by: treeNodes.trashedBy })
        .from(treeNodes)
        .where(and(inArray(treeNodes.id, [...documentIds]), isNotNull(treeNodes.trashRecord)));
      const purged = await tx
        .select({ id: documents.id, purgedAt: documents.contentPurgedAt })
        .from(documents)
        .where(and(inArray(documents.id, [...documentIds]), isNotNull(documents.contentPurgedAt)));
      const actorOf = await trashActorsOf(
        db,
        rows.map((row) => row.by),
      );

      for (const row of rows)
        out.set(row.id, {
          reason: "deleted",
          actor: actorOf(row.by),
          time: (row.trashedAt as Date).toISOString(),
        });
      for (const row of purged)
        out.set(row.id, {
          reason: "deleted",
          actor: null,
          time: (row.purgedAt as Date).toISOString(),
        });
      return out;
    },
  };
}
