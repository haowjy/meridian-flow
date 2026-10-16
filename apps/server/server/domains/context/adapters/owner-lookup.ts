/** Drizzle wiring of the owner lookup: Works, chats, subagents and the chats that hold files. */
import type { ThreadId } from "@meridian/contracts/runtime";
import { DAY_MS, decodeWorkHandle, WORK_DELETE_RETENTION_DAYS } from "@meridian/contracts/works";
import type { Database } from "@meridian/database";
import { contextSources, documents, threads, threadWorks, works } from "@meridian/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { TopPrimaryChatResolver } from "../../threads/ports/top-primary-chat.js";
import type { ChatUploadsOwners } from "../chat-uploads-owners.js";
import { createOwnerLookup, type OwnerLookup, type WorkOwner } from "../owner-lookup.js";
import type { ScratchLineages } from "../scratch-owner.js";

export function createDrizzleOwnerLookup(
  db: Database,
  deps: {
    chats: ChatUploadsOwners;
    lineages: ScratchLineages;
    topChats: TopPrimaryChatResolver;
  },
): OwnerLookup {
  return createOwnerLookup({
    chats: deps.chats,
    lineages: deps.lineages,
    async namedWorkHandle(threadId) {
      const [row] = await currentDrizzleDb(db)
        .select({ handle: works.handle, isNoWork: works.isNoWork })
        .from(threadWorks)
        .innerJoin(works, eq(works.id, threadWorks.workId))
        .where(and(eq(threadWorks.threadId, threadId as never), eq(threadWorks.isPrimary, true)))
        .limit(1);
      return row && !row.isNoWork ? row.handle : null;
    },
    async subagentChatRef(projectId, ref) {
      const [subagent] = await currentDrizzleDb(db)
        .select({ id: threads.id })
        .from(threads)
        .where(
          and(
            eq(threads.projectId, projectId as never),
            eq(threads.ref, ref),
            eq(threads.kind, "subagent"),
          ),
        )
        .limit(1);
      return subagent
        ? ((await deps.topChats.resolveTopPrimaryChat(subagent.id as ThreadId))?.chatRef ?? null)
        : null;
    },
    async works(projectId) {
      const rows = await currentDrizzleDb(db)
        .select({
          handle: works.handle,
          name: works.name,
          archivedAt: works.archivedAt,
          deletedAt: works.deletedAt,
        })
        .from(works)
        .where(and(eq(works.projectId, projectId as never), eq(works.isNoWork, false)));
      return rows.flatMap((row): WorkOwner[] => {
        const handle = decodeWorkHandle(row.handle);
        if (!handle) return [];
        const remaining = row.deletedAt
          ? Math.ceil(
              (row.deletedAt.getTime() + WORK_DELETE_RETENTION_DAYS * DAY_MS - Date.now()) / DAY_MS,
            )
          : null;
        return [
          {
            handle,
            name: row.name,
            state: row.deletedAt ? "deleted" : row.archivedAt ? "archived" : "active",
            restorableDays: remaining !== null && remaining > 0 ? remaining : null,
          },
        ];
      });
    },
    async chatsWithFiles(projectId) {
      const rows = await currentDrizzleDb(db)
        .selectDistinct({ chatRef: threads.ref, title: threads.title })
        .from(contextSources)
        .innerJoin(documents, eq(documents.contextSourceId, contextSources.id))
        .innerJoin(threads, eq(threads.id, contextSources.chatThreadId))
        .where(
          and(
            eq(contextSources.projectId, projectId as never),
            eq(contextSources.scope, "chat"),
            isNull(contextSources.deletedAt),
            isNull(documents.deletedAt),
            isNull(threads.deletedAt),
          ),
        );
      return rows.flatMap(({ chatRef, title }) => (chatRef ? [{ chatRef, title }] : []));
    },
  });
}
