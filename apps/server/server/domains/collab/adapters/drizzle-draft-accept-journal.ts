/** Drizzle adapter for accepted-draft live journal appends. */
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { agentEditMutations, documentYjsDrafts } from "@meridian/database";
import { and, eq, sql } from "drizzle-orm";
import type {
  AcceptedDraftAppend,
  DraftAcceptJournal,
  DraftAcceptMutation,
} from "../domain/drafts.js";
import { LIVE_SCOPE } from "./drizzle-agent-edit-scope.js";
import { createDrizzleJournal } from "./drizzle-journal.js";

type DraftDb = Pick<Database, "select" | "insert" | "update" | "delete" | "transaction">;

export function createDrizzleDraftAcceptJournal(db: DraftDb): DraftAcceptJournal {
  return {
    findAcceptedDraftAppend: (input) => findAcceptedDraftAppend(db, input),
    findDraftAcceptMutation: (input) => findDraftAcceptMutation(db, input),
    listAcceptedDraftAppendsByWriteIdPrefix: (input) =>
      listAcceptedDraftAppendsByWriteIdPrefix(db, input),
    async appendAcceptedDraft(input) {
      return db.transaction(async (tx) => {
        const txDb = tx as DraftDb;
        const existing = await findAcceptedDraftAppend(txDb, input);
        if (existing) return existing;

        const [fencedDraft] = await txDb
          .update(documentYjsDrafts)
          .set({ status: input.expectedDraftStatus })
          .where(
            and(
              eq(documentYjsDrafts.id, input.draftId),
              eq(documentYjsDrafts.documentId, input.documentId),
              eq(documentYjsDrafts.status, input.expectedDraftStatus),
            ),
          )
          .returning({ id: documentYjsDrafts.id });
        if (!fencedDraft) {
          throw new Error(`Draft is not ${input.expectedDraftStatus}: ${input.draftId}`);
        }

        const txJournal = createDrizzleJournal(tx as Parameters<typeof createDrizzleJournal>[0]);
        const [result] = await txJournal.appendBatch([
          {
            docId: input.documentId,
            update: input.update,
            meta: {
              origin: `human:${input.actorUserId}`,
              seq: 0,
            },
            mutation: {
              threadId: input.threadId,
              turnId: null,
              writeId: input.writeId,
            },
          },
        ]);
        if (!result) throw new Error(`Failed to append accepted draft ${input.draftId}`);
        return {
          appliedUpdateSeq: result.seq,
          threadId: input.threadId,
          writeId: input.writeId,
        };
      });
    },
  };
}

async function findDraftAcceptMutation(
  db: Pick<Database, "select">,
  input: { documentId: DocumentId; threadId: ThreadId; writeId: string },
): Promise<DraftAcceptMutation | null> {
  const [row] = await db
    .select({
      createdSeq: agentEditMutations.createdSeq,
      threadId: agentEditMutations.threadId,
      writeId: agentEditMutations.writeId,
      status: agentEditMutations.status,
    })
    .from(agentEditMutations)
    .where(
      and(
        eq(agentEditMutations.documentId, input.documentId),
        eq(agentEditMutations.threadId, input.threadId),
        eq(agentEditMutations.scopeId, LIVE_SCOPE),
        eq(agentEditMutations.writeId, input.writeId),
      ),
    )
    .limit(1);
  if (!row || (row.status !== "active" && row.status !== "reversed")) return null;
  return {
    appliedUpdateSeq: Number(row.createdSeq),
    threadId: row.threadId as ThreadId,
    writeId: row.writeId,
    status: row.status,
  };
}

async function findAcceptedDraftAppend(
  db: Pick<Database, "select">,
  input: { documentId: DocumentId; threadId: ThreadId; writeId: string },
): Promise<AcceptedDraftAppend | null> {
  const [row] = await db
    .select({
      createdSeq: agentEditMutations.createdSeq,
      threadId: agentEditMutations.threadId,
      writeId: agentEditMutations.writeId,
    })
    .from(agentEditMutations)
    .where(
      and(
        eq(agentEditMutations.documentId, input.documentId),
        eq(agentEditMutations.threadId, input.threadId),
        eq(agentEditMutations.scopeId, LIVE_SCOPE),
        eq(agentEditMutations.writeId, input.writeId),
        eq(agentEditMutations.status, "active"),
      ),
    )
    .limit(1);
  return row
    ? {
        appliedUpdateSeq: Number(row.createdSeq),
        threadId: row.threadId as ThreadId,
        writeId: row.writeId,
      }
    : null;
}

async function listAcceptedDraftAppendsByWriteIdPrefix(
  db: Pick<Database, "select">,
  input: { documentId: DocumentId; threadId: ThreadId; writeIdPrefix: string },
): Promise<AcceptedDraftAppend[]> {
  const rows = await db
    .select({
      createdSeq: agentEditMutations.createdSeq,
      threadId: agentEditMutations.threadId,
      writeId: agentEditMutations.writeId,
    })
    .from(agentEditMutations)
    .where(
      and(
        eq(agentEditMutations.documentId, input.documentId),
        eq(agentEditMutations.threadId, input.threadId),
        eq(agentEditMutations.scopeId, LIVE_SCOPE),
        sql`${agentEditMutations.writeId} LIKE ${`${input.writeIdPrefix}%`}`,
        eq(agentEditMutations.status, "active"),
      ),
    );
  return rows.map((row) => ({
    appliedUpdateSeq: Number(row.createdSeq),
    threadId: row.threadId as ThreadId,
    writeId: row.writeId,
  }));
}
