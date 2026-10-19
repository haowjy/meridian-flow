/** Reads immutable revert receipts and their retained source rooms, without write admission. */
import type { DocumentCoordinator, UpdateJournal } from "@meridian/agent-edit/integration";
import type { DocumentId, ThreadId } from "@meridian/contracts";
import { type Database, documentEditParts, documentEdits } from "@meridian/database";
import { and, eq } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { createRevertSourceResolver } from "../domain/agent-edit-cores.js";
import { type DraftStore, materializeDraftRead } from "../domain/draft-store.js";
import { liveRoom } from "../domain/observation-rooms.js";
import { storedDocument } from "./document-loader.js";

export function createDrizzleRevertSourceResolver(input: {
  db: Database;
  drafts: Pick<DraftStore, "readDraftAt">;
  journal: Pick<UpdateJournal, "read">;
}): DocumentCoordinator["resolveRevertSource"] {
  return createRevertSourceResolver({
    async receipt(threadId, documentId, wId) {
      const db = currentDrizzleDb(input.db);
      const [edit] = await db
        .select()
        .from(documentEdits)
        .where(
          and(
            eq(documentEdits.threadId, threadId as ThreadId),
            eq(documentEdits.documentId, documentId as DocumentId),
            eq(documentEdits.actor, "agent"),
            eq(documentEdits.kind, "write"),
            eq(documentEdits.wId, wId),
          ),
        )
        .limit(1);
      if (!edit) return null;
      const parts = await db
        .select({ effect: documentEditParts.effect })
        .from(documentEditParts)
        .where(eq(documentEditParts.editId, edit.id));
      if (!parts.some(({ effect }) => effect.inserted.length || effect.deleted.length)) return null;
      return {
        room: edit.sourceRoom,
        before: edit.beforeCut,
        after: edit.afterCut,
        effect: {
          inserted: parts.flatMap((p) => p.effect.inserted),
          deleted: parts.flatMap((p) => p.effect.deleted),
        },
      };
    },
    async source(room, documentId) {
      if (room.startsWith("draft:")) {
        const read = await input.drafts.readDraftAt(room.slice("draft:".length));
        if (
          !read ||
          read.documentDraft.documentId !== documentId ||
          read.documentDraft.kind !== "work_draft"
        )
          return { refusal: "source_unavailable", reason: "draft_missing" };
        if (read.documentDraft.status === "closed")
          return { refusal: "source_unavailable", reason: "draft_closed" };
        return { doc: materializeDraftRead(read) };
      }
      const snapshot = await input.journal.read(documentId);
      if (!snapshot.authority) return { refusal: "source_unavailable", reason: "live_missing" };
      if (room !== liveRoom(documentId, snapshot.authority.generation))
        return { refusal: "source_unavailable", reason: "live_generation_changed" };
      return { doc: storedDocument(snapshot) };
    },
  });
}
