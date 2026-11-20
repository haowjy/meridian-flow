/**
 * A document a Work creates is plain text in Live: its create is pending in the Work's tree, which
 * is its whole pending state, and the document opens in the Work's view as soon as the create is
 * admitted.
 */
import { writeBlocks } from "@meridian/agent-edit/diff";
import type { DocumentId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import {
  buildDocumentSchema,
  PROSEMIRROR_FRAGMENT_NAME,
  withBlockIds,
} from "@meridian/prosemirror-schema";
import { sql } from "drizzle-orm";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { DraftPeerShadowAccess } from "../contracts.js";
import type { MarkdownDocumentEngine } from "../domain/markdown-document.js";

export function createDrizzleWorkCreates(
  db: Database,
  deps: { documents: Pick<MarkdownDocumentEngine, "installSeeds" | "changeLiveDocument"> },
): Pick<DraftPeerShadowAccess, "seedWorkCreates" | "writeWorkCreatedContent"> {
  const schema = buildDocumentSchema();
  return {
    async seedWorkCreates(created) {
      if (!created.length) return;
      const tx = currentDrizzleDb(db);
      const ids = [...new Set(created.map(({ documentId }) => documentId))].sort();
      for (const id of ids) await lockDocumentMutation(tx, id);
      const fresh = await tx.execute<{ id: DocumentId }>(sql`
        SELECT v.id FROM (VALUES ${sql.join(
          ids.map((id) => sql`(${id}::uuid)`),
          sql`, `,
        )}) AS v(id)
        WHERE NOT EXISTS (SELECT 1 FROM document_yjs_heads h WHERE h.document_id = v.id)
          AND NOT EXISTS (SELECT 1 FROM document_yjs_checkpoints c WHERE c.document_id = v.id)
          AND NOT EXISTS (SELECT 1 FROM document_yjs_updates u WHERE u.document_id = v.id)`);
      await deps.documents.installSeeds(fresh.map(({ id }) => ({ documentId: id, state: null })));
    },
    async writeWorkCreatedContent(created, origin) {
      for (const { documentId, content } of created)
        await deps.documents.changeLiveDocument({
          documentId,
          origin,
          mutate: (doc) =>
            writeBlocks(
              doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME),
              schema,
              content.blocks.map(withBlockIds),
            ),
        });
    },
  };
}
