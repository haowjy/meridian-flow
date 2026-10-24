/** Drizzle wiring of the owner lookup: Works, chats, subagents and the chats that hold files. */
import type { ThreadId } from "@meridian/contracts/runtime";
import { DAY_MS, DELETION_RETENTION_DAYS, decodeWorkHandle } from "@meridian/contracts/works";
import type { Database } from "@meridian/database";
import { contextSources, documents, threads, threadWorks, works } from "@meridian/database/schema";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { TopPrimaryChatResolver } from "../../threads/ports/top-primary-chat.js";
import type { ChatUploadsOwners } from "../chat-uploads-owners.js";
import { createOwnerLookup, type OwnerLookup, type WorkOwner } from "../owner-lookup.js";
import type { ScratchLineages } from "../scratch-owner.js";

const NAMED_WORK_CANDIDATES = 5;

const workOwnerColumns = {
  handle: works.handle,
  name: works.name,
  archivedAt: works.archivedAt,
  deletedAt: works.deletedAt,
};

function foldAccents(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/** `foldAccents` in SQL: decompose, then drop combining marks. Needs a UTF8 database. */
const foldedWorkName = sql`regexp_replace(normalize(${works.name}, NFD), '[\u0300-\u036f]', '', 'g')`;

/** A name with accents folded, lowercased and every run of non-alphanumerics collapsed to one dash, as SQL compares it. */
function collapseName(name: string): string {
  return foldAccents(name)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

function toWorkOwner(row: {
  handle: string | null;
  name: string;
  archivedAt: Date | null;
  deletedAt: Date | null;
}): WorkOwner | null {
  const handle = decodeWorkHandle(row.handle);
  if (!handle) return null;
  const remaining = row.deletedAt
    ? Math.ceil((row.deletedAt.getTime() + DELETION_RETENTION_DAYS * DAY_MS - Date.now()) / DAY_MS)
    : null;
  return {
    handle,
    name: row.name,
    state: row.deletedAt ? "deleted" : row.archivedAt ? "archived" : "active",
    restorableDays: remaining !== null && remaining > 0 ? remaining : null,
  };
}

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
    async workByHandle(projectId, handle) {
      const [row] = await currentDrizzleDb(db)
        .select(workOwnerColumns)
        .from(works)
        .where(
          and(
            eq(works.projectId, projectId as never),
            eq(works.isNoWork, false),
            eq(works.handle, handle),
          ),
        )
        .limit(1);
      return row ? (toWorkOwner(row) ?? null) : null;
    },
    async worksNamed(projectId, name) {
      // Exact name, or the same name with punctuation and spacing collapsed: the two spellings
      // `findWorkNamed` accepts. Few rows can match, so the cap only guards a pathological project.
      const exact = foldAccents(name.trim()).toLowerCase();
      const collapsed = collapseName(name);
      const rows = await currentDrizzleDb(db)
        .select(workOwnerColumns)
        .from(works)
        .where(
          and(
            eq(works.projectId, projectId as never),
            eq(works.isNoWork, false),
            isNull(works.deletedAt),
            or(
              sql`lower(btrim(${foldedWorkName})) = ${exact}`,
              collapsed
                ? sql`btrim(regexp_replace(lower(${foldedWorkName}), '[^[:alnum:]]+', '-', 'g'), '-') = ${collapsed}`
                : undefined,
            ),
          ),
        )
        .limit(NAMED_WORK_CANDIDATES);
      return rows.flatMap((row) => toWorkOwner(row) ?? []);
    },
    async listWorks(projectId) {
      const rows = await currentDrizzleDb(db)
        .select(workOwnerColumns)
        .from(works)
        .where(
          and(
            eq(works.projectId, projectId as never),
            eq(works.isNoWork, false),
            isNull(works.deletedAt),
          ),
        );
      return rows.flatMap((row) => toWorkOwner(row) ?? []);
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
