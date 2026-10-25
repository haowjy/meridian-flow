/**
 * Drizzle persistence for ahead-link identities (contract §9): durable rows minted
 * for addresses with no document yet, settled by the first live document that
 * arrives at the exact address (or at registration, if one is already there).
 *
 * Registration and arrival serialize under the same sorted namespace keys. The caller of
 * `settleArrivals` already holds every arrival key; staged reveal registers its mints inside
 * that transaction after asserting the same keys are held.
 */
import type { ContextUriScheme } from "@meridian/contracts/context-uri";
import { parseRequestId } from "@meridian/contracts/request-id";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  contextSources,
  documentLinks,
  documents,
  linkAheadRefs,
  projects,
  works,
} from "@meridian/database/schema";
import { and, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import {
  currentDrizzleDb,
  isInDrizzleTransaction,
  runInRootDrizzleTransaction,
  runOutsideWrite,
} from "../../../shared/drizzle-transaction.js";
import {
  createNoopEventSink,
  type EventSink,
  emitEvent,
  unknownToEventPayload,
} from "../../observability/index.js";
import {
  type AheadRecoveryPage,
  type AheadRecoveryProgress,
  type AheadRecoveryScope,
  type AheadRegistration,
  type LinkAheadRegistry,
  RegistrationInsideTransactionError,
} from "../ports/link-ahead-registry.js";
import { assertNamespaceKeysHeld, lockNamespaceKeys } from "./context-fs/document-locations.js";
import {
  type DocumentAddress,
  listsThroughLiveManifest,
  loadDocumentAddresses,
  resolveCanonicalAddresses,
  sameCoordinates,
} from "./document-address.js";

/** Membership of the live manifest; `userId`-owned `user://` and non-drafted schemes never consult it. */
type MembershipResolver = (input: { projectId: ProjectId }) => Promise<{ members: string[] }>;

export class DrizzleLinkAheadRegistry implements LinkAheadRegistry {
  constructor(
    private readonly db: Database,
    private readonly resolveManifestMembership: MembershipResolver,
    private readonly eventSink: EventSink = createNoopEventSink(),
  ) {}

  private async resolveRegistrations(registrations: readonly AheadRegistration[]) {
    const addresses = await resolveCanonicalAddresses(this.db, registrations);
    return registrations.map((registration, index) => {
      const aheadId = parseRequestId(registration.aheadId);
      if (!aheadId) throw new RangeError(`Invalid ahead id: ${registration.aheadId}`);
      return { aheadId, address: addresses[index] };
    });
  }

  async register(registrations: readonly AheadRegistration[]): Promise<void> {
    if (isInDrizzleTransaction()) throw new RegistrationInsideTransactionError();
    if (!registrations.length) return;
    await runOutsideWrite(() =>
      runInRootDrizzleTransaction(this.db, async () => {
        const resolved = await this.resolveRegistrations(registrations);
        // Target-only registration is not an authored write, including archived Work targets.
        await lockNamespaceKeys(
          this.db,
          resolved.map(({ address }) => ({ ...address, workId: address.lockWorkId })),
        );
        await this.registerResolved(resolved);
      }),
    );
  }

  async registerWithinTransaction(registrations: readonly AheadRegistration[]): Promise<void> {
    if (!registrations.length) return;
    const resolved = await this.resolveRegistrations(registrations);
    assertNamespaceKeysHeld(
      resolved.map(({ address }) => ({ ...address, workId: address.lockWorkId })),
    );
    await this.registerResolved(resolved);
  }

  private async registerResolved(
    resolved: Awaited<ReturnType<DrizzleLinkAheadRegistry["resolveRegistrations"]>>,
  ): Promise<void> {
    const tx = currentDrizzleDb(this.db);
    const rows = resolved.map(({ aheadId, address }) => ({
      aheadId,
      projectId: address.projectId,
      scheme: address.scheme,
      workId: address.workId,
      rootThreadId: address.rootThreadId ?? null,
      path: address.path,
    }));
    const input = sql`jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as r(
      "aheadId" uuid, "projectId" uuid, scheme text, "workId" uuid, "rootThreadId" uuid, path text)`;
    await tx.execute(sql`insert into link_ahead_refs (ahead_id, project_id, scheme, work_id, root_thread_id, path)
      select "aheadId", "projectId", scheme, "workId", "rootThreadId", path from ${input}
      order by "aheadId" on conflict (ahead_id) do nothing`);
    const stored = new Map(
      (
        await tx
          .select()
          .from(linkAheadRefs)
          .where(
            inArray(
              linkAheadRefs.aheadId,
              rows.map((row) => row.aheadId),
            ),
          )
      ).map((row) => [row.aheadId, row]),
    );
    for (const { aheadId, address } of resolved) {
      const row = stored.get(aheadId);
      if (!row || !sameCoordinates(address, { ...row, scheme: row.scheme as ContextUriScheme }))
        throw new Error(`Ahead ref ${aheadId} was registered for another address`);
    }
    const candidates = await tx.execute<{ id: string }>(sql`
      with requested as materialized (select r.*, regexp_replace(r.path, '^.*/', '') as filename from ${input}),
      sources as materialized (
        select r.*, cs.id as source_id from requested r
        join context_sources cs on cs.slug = r.scheme left join works w on w.id = cs.work_id
        where r."projectId" = coalesce(cs.project_id,w.project_id)
          and r."workId" is not distinct from (case when w.is_no_work then null else cs.work_id end)
          and r."rootThreadId" is not distinct from cs.root_thread_id
      )
      select d.id from sources r join documents d on d.context_source_id = r.source_id
        and d.name || case when d.extension = '' then '' else '.' || d.extension end = r.filename
        where d.deleted_at is null and d.kind = 'content'`);
    await this.settleAddresses(
      await loadDocumentAddresses(this.db, { ids: candidates.map((row) => row.id) }),
      rows.map((row) => row.aheadId),
    );
  }

  async settleArrivals(documentIds: readonly DocumentId[]): Promise<number> {
    if (!documentIds.length) return 0;
    return this.settleAddresses(
      await loadDocumentAddresses(this.db, { ids: [...new Set(documentIds)] }),
    );
  }

  private async settleAddresses(
    addresses: readonly DocumentAddress[],
    aheadIds?: readonly string[],
  ): Promise<number> {
    const present = addresses.filter((address) => !address.deleted);
    if (!present.length) return 0;
    const tx = currentDrizzleDb(this.db);
    const records = (
      rows: readonly DocumentAddress[],
    ) => sql`jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
      as a("documentId" uuid, "projectId" uuid, scheme text, "workId" uuid, "rootThreadId" uuid, path text)`;
    const restricted = aheadIds
      ? sql`and r.ahead_id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(aheadIds)}::jsonb))`
      : sql``;
    const matching = sql`
      select r.ahead_id, a."documentId" from addresses a join link_ahead_refs r
        on r.project_id = a."projectId" and r.scheme = a.scheme
          and md5(r.path) = md5(a.path) and r.path = a.path
          and r.work_id is not distinct from a."workId" and r.root_thread_id is not distinct from a."rootThreadId"
        where r.settled_document_id is null ${restricted}`;
    const waiting = await tx.execute<{ documentId: string }>(sql`
      with addresses as (select * from ${records(present)})
      select distinct "documentId" from (${matching}) matches`);
    const wanted = new Set(waiting.map((row) => row.documentId));
    const candidates = present.filter((row) => wanted.has(row.documentId));
    const memberships = new Map<string, Set<string>>();
    for (const projectId of new Set(
      candidates.filter((row) => listsThroughLiveManifest(row.scheme)).map((row) => row.projectId),
    )) {
      memberships.set(
        projectId,
        new Set((await this.resolveManifestMembership({ projectId })).members),
      );
    }
    const live = candidates.filter(
      (row) =>
        !listsThroughLiveManifest(row.scheme) ||
        memberships.get(row.projectId)?.has(row.documentId),
    );
    if (!live.length) return 0;
    const settled = await tx.execute(sql`
      with addresses as (select * from ${records(live)}), matches as (${matching})
      update link_ahead_refs r set settled_document_id = matches."documentId", settled_at = now()
      from matches where r.ahead_id = matches.ahead_id and r.settled_document_id is null returning r.ahead_id`);
    return settled.length;
  }

  async registerUnregistered(
    scope: AheadRecoveryScope | undefined,
    page: AheadRecoveryPage,
  ): Promise<AheadRecoveryProgress> {
    if (isInDrizzleTransaction()) throw new RegistrationInsideTransactionError();
    const holderProject = sql`coalesce(${contextSources.projectId}, ${works.projectId})`;
    const pending = await this.db
      .selectDistinctOn([documentLinks.aheadId], {
        aheadId: documentLinks.aheadId,
        address: documentLinks.address,
        holderProjectId: sql<ProjectId>`${holderProject}`,
      })
      .from(documentLinks)
      .innerJoin(documents, eq(documents.id, documentLinks.sourceDocumentId))
      .innerJoin(contextSources, eq(contextSources.id, documents.contextSourceId))
      .leftJoin(works, eq(works.id, contextSources.workId))
      .innerJoin(projects, sql`${projects.id} = ${holderProject}`)
      .leftJoin(linkAheadRefs, eq(linkAheadRefs.aheadId, documentLinks.aheadId))
      .where(
        and(
          isNotNull(documentLinks.aheadId),
          isNotNull(documentLinks.address),
          isNull(linkAheadRefs.aheadId),
          isNull(documents.deletedAt),
          scope === undefined
            ? undefined
            : "documentId" in scope
              ? eq(documentLinks.sourceDocumentId, scope.documentId)
              : scope.personalOwnerId
                ? eq(projects.userId, scope.personalOwnerId)
                : sql`${holderProject} = ${scope.projectId}`,
          page.after ? gt(documentLinks.aheadId, page.after) : undefined,
        ),
      )
      .orderBy(documentLinks.aheadId)
      .limit(page.limit);
    let registered = 0;
    for (const row of pending) {
      if (!row.aheadId || !row.address) continue;
      try {
        await this.register([
          { aheadId: row.aheadId, holderProjectId: row.holderProjectId, address: row.address },
        ]);
        registered++;
      } catch (cause) {
        emitEvent(this.eventSink, {
          level: "warn",
          source: "context.link-ahead",
          name: "AheadRegistrationFailed",
          payload: { aheadId: row.aheadId, ...unknownToEventPayload(cause) },
        });
      }
    }
    // Advance by attempted keys, not registrations: a ref that keeps failing never pins the page.
    const last = pending.at(-1)?.aheadId;
    return { registered, next: pending.length === page.limit && last ? last : null };
  }
}

export function createDrizzleLinkAheadRegistry(
  db: Database,
  resolveManifestMembership: MembershipResolver,
  eventSink?: EventSink,
): LinkAheadRegistry {
  return new DrizzleLinkAheadRegistry(db, resolveManifestMembership, eventSink);
}
