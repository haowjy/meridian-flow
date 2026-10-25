/** Private Context batches and a set-wise reveal under one union of namespace locks. */
import type { AheadMint } from "@meridian/agent-edit/integration";
import { parseContextUri } from "@meridian/contracts/context-uri";
import { folderDocumentName, renderFilename } from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  contextSources,
  contextStagedDocuments,
  contextStagedFolders,
} from "@meridian/database/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { lockSeamWorks } from "../../../shared/work-lifecycle-lock.js";
import type { MarkdownDocumentStore } from "../../collab/index.js";
import { lockNamespaceKeys } from "../adapters/context-fs/document-locations.js";
import { resolveCanonicalAddresses } from "../adapters/document-address.js";
import { allocateFilename } from "../context/paths.js";
import type { ContextCatalogMutationPort } from "../ports/context-catalog.js";
import type { ContextStagedCreation } from "../ports/context-staged-creation.js";
import type { DocumentArrivals } from "../ports/document-arrivals.js";
import type { AheadRegistration, LinkAheadRegistry } from "../ports/link-ahead-registry.js";
import {
  createTreeReader,
  LIVE_TREE,
  visibleDocumentsSql,
  visibleFoldersSql,
} from "./tree-view.js";

export function createDrizzleContextStagedCreation(deps: {
  db: Database;
  projectId: string;
  userId: string;
  documents: Pick<
    MarkdownDocumentStore,
    "stageInitialStates" | "commitStagedStates" | "discardStagedStates"
  >;
  ahead: Pick<LinkAheadRegistry, "registerWithinTransaction">;
  arrivals: DocumentArrivals;
  catalog: ContextCatalogMutationPort;
}): ContextStagedCreation {
  const { db, projectId, userId } = deps;
  const sourcesWhere = and(
    eq(contextSources.projectId, projectId),
    isNull(contextSources.workId),
    isNull(contextSources.rootThreadId),
    isNull(contextSources.deletedAt),
  );
  return {
    async stage(stagingId, generation, nodes) {
      const tx = currentDrizzleDb(db);
      if (nodes.folders.length)
        await tx
          .insert(contextStagedFolders)
          .values(nodes.folders.map((node) => ({ ...node, stagingId, generation, projectId })));
      if (nodes.documents.length)
        await tx.insert(contextStagedDocuments).values(
          nodes.documents.map(({ content, metadata, ...node }) => {
            if (content.kind === "tracked" && content.seed.documentId !== node.id)
              throw new Error("Staged seed belongs to another document");
            return {
              ...node,
              metadata: metadata ?? {},
              stagingId,
              generation,
              projectId,
              storageUrl: content.kind === "binary" ? content.storageUrl : null,
              mimeType: content.kind === "binary" ? content.mimeType : null,
              sizeBytes:
                content.kind === "binary"
                  ? content.sizeBytes
                  : Buffer.byteLength(content.seed.markdown, "utf8"),
              aheadMints: content.kind === "tracked" ? content.aheadMints : [],
            };
          }),
        );
      await deps.documents.stageInitialStates(
        stagingId,
        projectId,
        generation,
        nodes.documents.flatMap((node) =>
          node.content.kind === "tracked" ? [node.content.seed] : [],
        ),
      );
    },

    async commitStaged(stagingId, expected) {
      const tx = currentDrizzleDb(db);
      const [dirs, files] = await Promise.all([
        tx.select().from(contextStagedFolders).where(eq(contextStagedFolders.stagingId, stagingId)),
        tx
          .select()
          .from(contextStagedDocuments)
          .where(eq(contextStagedDocuments.stagingId, stagingId)),
      ]);
      const registrations: AheadRegistration[] = files.flatMap((file) =>
        (file.aheadMints as AheadMint[]).map((mint) => ({
          aheadId: mint.ref.slice("ahead:".length),
          holderProjectId: mint.holderProjectId as ProjectId,
          address: mint.address,
        })),
      );
      const targets = await resolveCanonicalAddresses(db, registrations);
      // Target-only Works are not authored destinations. Never provision their sources
      // or require active state; their namespace keys serialize registry settlement.
      await lockSeamWorks(db, []);
      await lockNamespaceKeys(db, [
        ...expected.destinations.map((destination) => ({
          projectId,
          userId,
          scheme: destination.area,
          workId: null,
        })),
        ...targets.map((target) => ({ ...target, workId: target.lockWorkId })),
      ]);

      const nodes = [
        ...dirs.map((row) => ({ ...row, kind: "folder" as const, extension: "" })),
        ...files.map((row) => ({ ...row, kind: "file" as const })),
      ];
      if (
        nodes.some((row) => row.generation !== expected.generation || row.projectId !== projectId)
      )
        return { kind: "changed" };
      const [invalidSeed] = await tx.execute(sql`
        select 1 from collab_staged_states s
        full join context_staged_documents d on d.staging_id = s.staging_id and d.id = s.document_id
        where coalesce(s.staging_id,d.staging_id) = ${stagingId} and
          (s.generation is distinct from ${expected.generation} or s.project_id is distinct from ${projectId}::uuid
           or d.id is null or (d.storage_url is null and s.document_id is null))
          and (d.storage_url is null or s.document_id is not null) limit 1`);
      if (invalidSeed) return { kind: "changed" };
      const tree = createTreeReader(db);
      const destinations: {
        area: string;
        folderId: string | null;
        path: string;
        sourceId: string | null;
      }[] = [];
      const sources = await tx
        .select({ id: contextSources.id, area: contextSources.slug })
        .from(contextSources)
        .where(sourcesWhere);
      const sourceOf = new Map(sources.map((row) => [row.area, row.id]));
      for (const destination of expected.destinations) {
        const parsed = parseContextUri(destination.uri);
        if (
          !parsed.ok ||
          parsed.value.scheme !== destination.area ||
          parsed.value.normalized !==
            (destination.folderId ? destination.uri.replace(/\/$/, "") : destination.uri)
        )
          return { kind: "changed" };
        if (destination.folderId) {
          const live = await tree.findFolderById(LIVE_TREE, destination.folderId as never);
          if (
            !live ||
            live.contextSourceId !== sourceOf.get(destination.area) ||
            live.path !== parsed.value.path
          )
            return { kind: "changed" };
        } else if (parsed.value.path !== "") return { kind: "changed" };
        destinations.push({
          ...destination,
          path: parsed.value.path,
          sourceId: sourceOf.get(destination.area) ?? null,
        });
      }
      const stagedFolders = new Map(dirs.map((row) => [row.id, row]));
      const top = nodes.filter((row) => !row.parentId || !stagedFolders.has(row.parentId));
      if (
        top.length !== expected.topLevelNames.size ||
        top.some((row) => expected.topLevelNames.get(row.id) !== row.name)
      )
        return { kind: "changed" };
      const parentKey = (area: string, id: string | null) => JSON.stringify([area, id]);
      const parentOf = new Set(destinations.map((row) => parentKey(row.area, row.folderId)));
      if (top.some((row) => !parentOf.has(parentKey(row.area, row.parentId))))
        return { kind: "changed" };
      if (
        nodes.some(
          (row) =>
            row.parentId &&
            stagedFolders.has(row.parentId) &&
            stagedFolders.get(row.parentId)?.area !== row.area,
        )
      )
        return { kind: "changed" };
      const [reachable] = await tx.execute<{ count: number }>(sql`
        with recursive nodes as (
          select id, parent_id, area from context_staged_folders where staging_id = ${stagingId}
          union all select id, parent_id, area from context_staged_documents where staging_id = ${stagingId}
        ), destinations as (select * from jsonb_to_recordset(${JSON.stringify(destinations)}::jsonb) as x(area text, "folderId" uuid)),
        connected as (
          select n.id, n.area from nodes n join destinations d on n.area = d.area and n.parent_id is not distinct from d."folderId"
          union select n.id, n.area from nodes n join connected p on n.parent_id = p.id and n.area = p.area
        ) select count(*)::integer as count from connected`);
      if (reachable.count !== nodes.length) return { kind: "changed" };
      const siblings = await tx.execute<{
        area: string;
        parentId: string | null;
        kind: "file" | "folder";
        name: string;
        extension: string;
      }>(sql`
        with destinations as (select * from jsonb_to_recordset(${JSON.stringify(destinations)}::jsonb) as x(area text, "folderId" uuid, "sourceId" uuid))
        select x.area, f.parent_id as "parentId", 'folder' as kind, f.name, '' as extension
        from destinations x join ${visibleFoldersSql(LIVE_TREE)} f on f.context_source_id = x."sourceId" and f.parent_id is not distinct from x."folderId"
        union all
        select x.area, d.folder_id, 'file', d.name, d.extension from destinations x join ${visibleDocumentsSql(LIVE_TREE)} d
          on d.context_source_id = x."sourceId" and d.folder_id is not distinct from x."folderId"`);
      const occupied = new Map(
        destinations.map((row) => [
          parentKey(row.area, row.folderId),
          {
            files: new Set<string>(),
            folders: new Set<string>(),
            folderAliases: new Set<string>(),
          },
        ]),
      );
      const reserve = (row: {
        area: string;
        parentId: string | null;
        kind: string;
        name: string;
        extension: string;
      }) => {
        const names = occupied.get(parentKey(row.area, row.parentId));
        if (!names) throw new Error("Staged parent not in placement");
        if (row.kind === "folder") {
          names.folders.add(row.name);
          names.folderAliases.add(folderDocumentName(row.name));
        } else names.files.add(renderFilename(row.name, row.extension));
      };
      for (const row of siblings) reserve(row);
      for (const row of top) {
        const names = occupied.get(parentKey(row.area, row.parentId));
        if (
          !names ||
          (await allocateFilename(row, names)) !== renderFilename(row.name, row.extension)
        )
          return { kind: "changed" };
        reserve(row);
      }

      // Provision only after every placement check. No later namespace acquisition.
      await tx.execute(sql`insert into context_sources (project_id, slug, name, scope, adapter_type)
        select ${projectId}::uuid, area, case area when 'kb' then 'Knowledge Base' when 'manuscript' then 'Manuscript' else 'Unfiled' end, 'project', 'local'
        from (select distinct area from context_staged_folders where staging_id = ${stagingId}
          union select distinct area from context_staged_documents where staging_id = ${stagingId}) areas
        on conflict (project_id, slug) where work_id is null and root_thread_id is null and chat_thread_id is null and deleted_at is null do nothing`);
      const liveSources = nodes.length
        ? await tx
            .select({ id: contextSources.id })
            .from(contextSources)
            .where(
              and(
                sourcesWhere,
                inArray(contextSources.slug, [...new Set(nodes.map((row) => row.area))]),
              ),
            )
        : [];
      await tx.execute(sql`insert into folders (id, context_source_id, parent_id, name, document_alias)
        select f.id, cs.id, f.parent_id, f.name, f.name from context_staged_folders f join context_sources cs
          on cs.project_id = f.project_id and cs.slug = f.area and cs.work_id is null and cs.root_thread_id is null and cs.deleted_at is null
        where f.staging_id = ${stagingId}`);
      await tx.execute(sql`insert into documents
        (id, context_source_id, folder_id, name, extension, file_type, metadata, storage_url, mime_type, size_bytes)
        select d.id, cs.id, d.parent_id, d.name, d.extension, d.filetype, d.metadata, d.storage_url, d.mime_type,
          case when d.storage_url is null then octet_length(s.markdown) else d.size_bytes end
        from context_staged_documents d join context_sources cs on cs.project_id = d.project_id and cs.slug = d.area
          and cs.work_id is null and cs.root_thread_id is null and cs.deleted_at is null
        left join collab_staged_states s on s.staging_id = d.staging_id and s.document_id = d.id
        where d.staging_id = ${stagingId}`);
      await tx.execute(sql`insert into document_markdown_projections (document_id, markdown)
        select d.id, coalesce(s.markdown, '') from context_staged_documents d
        left join collab_staged_states s on s.staging_id = d.staging_id and s.document_id = d.id
        where d.staging_id = ${stagingId} and d.storage_url is null`);
      await tx.execute(sql`
        with recursive nodes as (
          select id, parent_id, area, name as filename from context_staged_folders where staging_id = ${stagingId}
          union all select id, parent_id, area, name || case when extension = '' then '' else '.' || extension end
          from context_staged_documents where staging_id = ${stagingId}
        ), destinations as (select * from jsonb_to_recordset(${JSON.stringify(destinations)}::jsonb) as x(area text, "folderId" uuid, path text)),
        paths as (
          select n.id, n.area, concat_ws('/', nullif(d.path,''), n.filename) as path from nodes n join destinations d
            on n.area = d.area and n.parent_id is not distinct from d."folderId"
          union all select n.id, n.area, p.path || '/' || n.filename from nodes n join paths p on n.parent_id = p.id and n.area = p.area
        )
        delete from document_previous_locations previous using paths p, context_sources cs
        where cs.project_id = ${projectId} and cs.slug = p.area and cs.work_id is null and cs.root_thread_id is null and cs.deleted_at is null
          and previous.context_source_id = cs.id and previous.path = p.path`);
      await deps.documents.commitStagedStates(stagingId);
      await deps.ahead.registerWithinTransaction(registrations);
      const ids = files.map((row) => row.id as DocumentId);
      await deps.arrivals.settle(ids);
      const sourceIds = liveSources.map((row) => row.id);
      await deps.catalog.refreshSources(sourceIds);
      await tx
        .delete(contextStagedDocuments)
        .where(eq(contextStagedDocuments.stagingId, stagingId));
      await tx.delete(contextStagedFolders).where(eq(contextStagedFolders.stagingId, stagingId));
      return { kind: "committed", sourceIds };
    },

    async discardStaged(stagingId, limit) {
      return discardDrizzleContextStage(db, deps.documents, stagingId, limit);
    },
  };
}

export function discardDrizzleContextStage(
  db: Database,
  documents: Pick<MarkdownDocumentStore, "discardStagedStates">,
  stagingId: string,
  limit?: number,
): Promise<{ remaining: boolean }> {
  return runInDrizzleTransaction(db, async () => {
    const tx = currentDrizzleDb(db);
    for (const table of [contextStagedDocuments, contextStagedFolders]) {
      await tx
        .delete(table)
        .where(
          and(
            eq(table.stagingId, stagingId),
            limit === undefined
              ? undefined
              : inArray(
                  table.id,
                  tx
                    .select({ id: table.id })
                    .from(table)
                    .where(eq(table.stagingId, stagingId))
                    .orderBy(table.id)
                    .limit(limit),
                ),
          ),
        );
    }
    const collab = await documents.discardStagedStates(stagingId, limit);
    const [remaining] =
      await tx.execute(sql`select 1 from context_staged_folders where staging_id = ${stagingId}
        union all select 1 from context_staged_documents where staging_id = ${stagingId} limit 1`);
    return { remaining: collab.remaining || !!remaining };
  });
}
