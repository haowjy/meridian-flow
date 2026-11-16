import { type BranchId, createdDraftId, type DocumentId, type UserId } from "@meridian/contracts";
import { contextRootUri, isContextUriScheme } from "@meridian/contracts/context-uri";
import type { Database } from "@meridian/database";
import { documentDrafts } from "@meridian/database/schema";
import {
  COLLAB_SCHEMA_VERSION,
  createCollabYDoc,
  packCollabSchemaVersion,
} from "@meridian/prosemirror-schema";
import { sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { branchMayHold, loadBranchHolder } from "../../context/tree/branch-ownership.js";
import { livingDocumentSql, requireLivingDocument } from "../../context/tree/living-document.js";
import { ownerFrom } from "../../context/tree/source-owner.js";
import { isDrafted } from "../../file-policy/index.js";
import { seedDraftState } from "../domain/draft-content.js";
import type { MarkdownDocumentEngine } from "../domain/markdown-document.js";
import type { ApplicationDraftStore } from "../domain/ports/application-draft-store.js";

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
      const owners = await tx.execute<{
        id: DocumentId;
        living: boolean;
        project_id: string | null;
        user_id: string | null;
        account_id: UserId;
        scheme: string;
      }>(sql`
        select d.id, ${livingDocumentSql(sql`d.id`)} as living, coalesce(s.project_id, w.project_id) as project_id,
          s.user_id, coalesce(s.user_id, p.user_id) as account_id, s.slug as scheme
        from documents d
        left join lateral (
          select context_source_id from (
            select id, context_source_id, file_type, 0 as ord from tree_nodes where id = d.id
            union all
            select id, context_source_id, file_type, 1 as ord from branch_tree_nodes where id = d.id
          ) placement where file_type is not null order by ord limit 1
        ) placement on true
        left join context_sources s on s.id = placement.context_source_id
        left join works w on w.id = s.work_id
        left join projects p on p.id = coalesce(s.project_id, w.project_id)
        where d.id in (${ids})`);
      const ownerById = new Map(owners.map((row) => [row.id, row]));
      const holders = new Map<BranchId, Awaited<ReturnType<typeof loadBranchHolder>>>();
      for (const { id, branch_id } of fresh) {
        const row = ownerById.get(id);
        if (!row?.living) await requireLivingDocument(tx, id);
        if (row && isContextUriScheme(row.scheme) && !isDrafted(row.scheme))
          throw new Error(
            `Document ${id} is in ${contextRootUri(row.scheme)}, which is never drafted`,
          );
        if (!holders.has(branch_id)) holders.set(branch_id, await loadBranchHolder(tx, branch_id));
        const holder = holders.get(branch_id);
        if (
          !row?.scheme ||
          !holder ||
          !branchMayHold(holder, {
            owner: ownerFrom({ projectId: row.project_id, userId: row.user_id }),
            accountId: row.account_id,
            scheme: row.scheme,
          })
        )
          throw new Error(`Branch ${branch_id} may not hold document ${id}`);
      }
      await deps.documents.installSeeds(fresh.map(({ id }) => ({ documentId: id, state: null })));
      const empty = createCollabYDoc({ gc: false });
      let checkpoint: ReturnType<typeof seedDraftState>;
      try {
        checkpoint = seedDraftState(empty, null, 0);
      } finally {
        empty.destroy();
      }
      const insertedIds = new Set<string>();
      for (let offset = 0; offset < fresh.length; offset += 500) {
        const inserted = await tx
          .insert(documentDrafts)
          .values(
            fresh.slice(offset, offset + 500).map(({ id, branch_id }) => ({
              id: createdDraftId(id),
              documentId: id,
              branchId: branch_id,
              kind: "work_draft" as const,
              status: "active" as const,
              state: checkpoint.state,
              stateVector: checkpoint.stateVector,
              hasEffect: false,
              hasEffectRevision: 0,
              schemaVersion: packCollabSchemaVersion(COLLAB_SCHEMA_VERSION),
            })),
          )
          .onConflictDoNothing()
          .returning({ id: documentDrafts.id });
        for (const { id } of inserted) insertedIds.add(id);
      }
      other.push(...fresh.filter(({ id }) => !insertedIds.has(createdDraftId(id))));
    }
    for (const { id, branch_id } of other) {
      await deps.documents.ensureDocumentAuthority(id);
      await deps.drafts.ensureCreatedDocumentDraft({ documentId: id, branchId: branch_id });
    }
  };
}
