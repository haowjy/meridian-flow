import type { DocumentId, UserId } from "@meridian/contracts";
import type { DocumentRemovalRecord } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { documents, threads, treeNodes, users } from "@meridian/database/schema";
import { and, inArray, isNotNull } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { isUuid } from "../../../shared/uuid.js";
import type { DocumentRemovals } from "../ports/document-removal.js";

type Actor = DocumentRemovalRecord["actor"];

const chatOf = (by: string) => by.slice("agent:".length).split("/")[0] ?? "";

/**
 * A document is removed while its node is in Trash, or once its content is purged. The delete's
 * author is the actor the node's row kept from the delete record (`trashed_by`): `user:<id>`, or
 * `agent:<chat>/<turn>`. A node that kept none, or an author whose account or chat is gone,
 * leaves the record with no actor.
 */
export function createTrashRemovals(db: Database): DocumentRemovals {
  return {
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

      const authors = new Map(rows.map((row) => [row.id, row.by]));
      const userIds = new Set<string>();
      const chatIds = new Set<string>();
      for (const by of authors.values()) {
        const id = by?.startsWith("user:")
          ? by.slice(5)
          : by?.startsWith("agent:")
            ? chatOf(by)
            : "";
        if (!isUuid(id)) continue;
        (by?.startsWith("user:") ? userIds : chatIds).add(id);
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
      const actorOf = (by: string | null | undefined): Actor => {
        if (by?.startsWith("user:")) {
          const userId = by.slice("user:".length);
          return names.has(userId)
            ? { kind: "user", userId: userId as UserId, displayName: names.get(userId) ?? null }
            : null;
        }
        if (by?.startsWith("agent:")) {
          const chatId = chatOf(by);
          return titles.has(chatId)
            ? { kind: "agent", chatTitle: titles.get(chatId)?.trim() || null }
            : null;
        }
        return null;
      };

      for (const row of rows)
        out.set(row.id, {
          reason: "deleted",
          actor: actorOf(row.by),
          time: (row.trashedAt as Date).toISOString(),
        });
      for (const row of purged)
        out.set(row.id, {
          reason: "deleted",
          actor: actorOf(authors.get(row.id)),
          time: (row.purgedAt as Date).toISOString(),
        });
      return out;
    },
  };
}
