/** Drizzle wiring of the chat file-address lookup: the chat's primary named Work, if any. */
import type { Database } from "@meridian/database";
import { threadWorks, works } from "@meridian/database/schema";
import { and, eq } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { TopPrimaryChatResolver } from "../../threads/ports/top-primary-chat.js";
import { type ChatFileLookup, createChatFileLookup } from "../chat-file-addresses.js";
import type { ChatUploadsOwners } from "../chat-uploads-owners.js";
import type { ScratchLineages } from "../scratch-owner.js";

export function createDrizzleChatFileLookup(
  db: Database,
  deps: {
    chats: ChatUploadsOwners;
    topPrimaryChats: TopPrimaryChatResolver;
    lineages: ScratchLineages;
  },
): ChatFileLookup {
  return createChatFileLookup({
    ...deps,
    async namedWorkSlug(threadId) {
      const [row] = await currentDrizzleDb(db)
        .select({ slug: works.slug, isNoWork: works.isNoWork })
        .from(threadWorks)
        .innerJoin(works, eq(works.id, threadWorks.workId))
        .where(and(eq(threadWorks.threadId, threadId as never), eq(threadWorks.isPrimary, true)))
        .limit(1);
      return row && !row.isNoWork ? row.slug : null;
    },
  });
}
