import type { ChatUploadsResult } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { contextSources, uploadIntakes } from "@meridian/database/schema";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { LIVE_TREE, visibleDocuments } from "../tree/tree-view.js";

export interface ChatUploads {
  /** The chat's uploads that are placed in its list now, newest first. */
  list(projectId: string, chatId: string): Promise<ChatUploadsResult>;
}

/**
 * What the chat's own query adds to its uploads in the tree list. `used` is the intake's
 * `already_used` rule: a sent message consumed the upload.
 */
export function createDrizzleChatUploads(db: Database): ChatUploads {
  return {
    async list(projectId, chatId) {
      const placed = visibleDocuments(LIVE_TREE);
      const rows = await currentDrizzleDb(db)
        .select({
          documentId: uploadIntakes.documentId,
          createdAt: uploadIntakes.createdAt,
          consumedAt: uploadIntakes.consumedAt,
        })
        .from(uploadIntakes)
        .innerJoin(
          contextSources,
          and(
            eq(contextSources.chatThreadId, chatId as never),
            eq(contextSources.projectId, projectId as never),
            isNull(contextSources.deletedAt),
          ),
        )
        .innerJoin(
          placed,
          and(
            eq(placed.id, uploadIntakes.documentId),
            eq(placed.contextSourceId, contextSources.id),
          ),
        )
        .where(
          and(
            eq(uploadIntakes.projectId, projectId as never),
            eq(uploadIntakes.ownerThreadId, chatId as never),
            ne(uploadIntakes.state, "deleted"),
          ),
        )
        .orderBy(desc(uploadIntakes.createdAt), desc(uploadIntakes.documentId));
      return {
        uploads: rows.map((row) => ({
          documentId: row.documentId,
          attachedAt: row.createdAt.toISOString(),
          used: row.consumedAt !== null,
        })),
      };
    },
  };
}
