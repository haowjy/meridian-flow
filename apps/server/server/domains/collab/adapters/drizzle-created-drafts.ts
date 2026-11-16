import { type BranchId, createdDraftId, type DocumentId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import { sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { loadBranchHolder, loadDocumentOwners } from "../../context/tree/branch-ownership.js";
import { livingDocumentSql, requireLivingDocument } from "../../context/tree/living-document.js";
import { seedDraftState } from "../domain/draft-content.js";
import type { MarkdownDocumentEngine } from "../domain/markdown-document.js";
import type { ApplicationDraftStore } from "../domain/ports/application-draft-store.js";
import { assertDraftable, insertCreatedDrafts } from "./drizzle-drafts.js";

export function createDrizzleCreatedDrafts(
  db: Database,
  deps: {
    documents: Pick<MarkdownDocumentEngine, "ensureDocumentAuthority" | "installSeeds">;
    drafts: Pick<ApplicationDraftStore, "ensureCreatedDocumentDraft">;
  },
) {
  return async (created: readonly { documentId: DocumentId; branchId: BranchId }[]) => {
    if (!created.length) return;
    const tx = currentDrizzleDb(db);
    const manifest = JSON.stringify(
      created.map(({ documentId, branchId }) => ({
        id: documentId,
        branch_id: branchId,
        draft_id: createdDraftId(documentId),
      })),
    );
    const records = sql`jsonb_to_recordset(${manifest}::jsonb) as v(id uuid, branch_id uuid, draft_id text)`;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('document-mutation:' || id::text, 0::bigint))
      from (select distinct id from ${records} order by id) sorted`);
    const rows = await tx.execute<{ id: DocumentId; branch_id: BranchId; fresh: boolean }>(sql`
      select v.id, v.branch_id,
        not exists (select 1 from document_yjs_heads h where h.document_id = v.id)
        and not exists (select 1 from document_yjs_checkpoints c where c.document_id = v.id)
        and not exists (select 1 from document_yjs_updates u where u.document_id = v.id)
        and not exists (select 1 from document_drafts d where d.id = v.draft_id)
        and not exists (select 1 from document_drafts d where d.document_id = v.id and d.kind = 'work_draft' and d.status = 'active') as fresh
      from ${records}`);
    const fresh = rows.filter((row) => row.fresh);
    const other = rows.filter((row) => !row.fresh);
    if (fresh.length) {
      const ids = sql.join(
        fresh.map(({ id }) => sql`${id}::uuid`),
        sql`, `,
      );
      const [owners, living] = await Promise.all([
        loadDocumentOwners(
          tx,
          fresh.map(({ id }) => id),
        ),
        tx.execute<{ id: DocumentId; living: boolean }>(sql`
          select d.id, ${livingDocumentSql(sql`d.id`)} as living from documents d where d.id in (${ids})`),
      ]);
      const livingById = new Map(living.map((row) => [row.id, row.living]));
      const holders = new Map<BranchId, Awaited<ReturnType<typeof loadBranchHolder>>>();
      for (const { id, branch_id } of fresh) {
        if (!livingById.get(id)) await requireLivingDocument(tx, id);
        if (!holders.has(branch_id)) holders.set(branch_id, await loadBranchHolder(tx, branch_id));
        assertDraftable(id, branch_id, owners.get(id) ?? null, holders.get(branch_id) ?? null);
      }
      await deps.documents.installSeeds(fresh.map(({ id }) => ({ documentId: id, state: null })));
      const empty = createCollabYDoc({ gc: false });
      let checkpoint: ReturnType<typeof seedDraftState>;
      try {
        checkpoint = seedDraftState(empty, null, 0);
      } finally {
        empty.destroy();
      }
      const insertedIds = await insertCreatedDrafts(db, fresh, checkpoint);
      other.push(...fresh.filter(({ id }) => !insertedIds.has(createdDraftId(id))));
    }
    for (const { id, branch_id } of other) {
      await deps.documents.ensureDocumentAuthority(id);
      await deps.drafts.ensureCreatedDocumentDraft({ documentId: id, branchId: branch_id });
    }
  };
}
