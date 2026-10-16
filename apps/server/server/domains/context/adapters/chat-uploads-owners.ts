/** Chat lookup for `uploads://@/c12/` addresses. */
import type { Database } from "@meridian/database";
import { threads } from "@meridian/database/schema";
import { and, eq } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { ChatUploadsOwners } from "../chat-uploads-owners.js";

export function createDrizzleChatUploadsOwners(db: Database): ChatUploadsOwners {
  return {
    async byRef(projectId, ref) {
      const [chat] = await currentDrizzleDb(db)
        .select({ id: threads.id, ref: threads.ref, deletedAt: threads.deletedAt })
        .from(threads)
        .where(
          and(eq(threads.projectId, projectId), eq(threads.ref, ref), eq(threads.kind, "primary")),
        )
        .limit(1);
      return chat?.ref
        ? { chatId: chat.id, chatRef: chat.ref, live: chat.deletedAt === null }
        : null;
    },
  };
}
