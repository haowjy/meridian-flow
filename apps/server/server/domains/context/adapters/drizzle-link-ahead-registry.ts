/**
 * Drizzle persistence for ahead-link identities (contract §9): durable rows minted
 * for addresses with no document yet, settled by the first live document that
 * arrives at the exact address (or at registration, if one is already there).
 * A row awaiting a planned identity is settled only by that document, wherever
 * it lands, until it is released, and then behaves like any other row.
 *
 * Serialization. One lock order per transaction: namespace keys (sorted), then awaited
 * stripes (sorted), then registry rows. A row at an address settles under that address's
 * namespace key, which registration, every arrival and `releaseAwaiting` take. A row awaiting
 * an id has no address to lock (the document has no row until it lands), so registration
 * and arrival meet on a stripe of advisory locks keyed by the awaited id. Stripes are held
 * to commit, so a transaction takes them in one sorted phase: `settleArrivals` is called
 * once per transaction with every arrival (lineage reconciliation hands its ids back to the
 * caller, Work restore settles the union), and a call that would take a stripe below one
 * already held throws. A stripe holder never waits on a namespace key, so no cycle closes.
 * Either registration commits first and the arrival's settle sees the row, or the arrival
 * commits first and registration finds the document live. Release flips refs to address mode
 * under their addresses' keys, so an uncommitted foreign arrival there finishes first and a
 * later one finds the ref in address mode.
 */
import { type ContextUriScheme, isProjectScopedScheme } from "@meridian/contracts/context-uri";
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
import { and, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
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
  type DocumentCoordinates,
  documentAt,
  listsThroughLiveManifest,
  loadDocumentAddresses,
  resolveCanonicalAddresses,
  sameCoordinates,
} from "./document-address.js";

/** Membership of the live manifest; `userId`-owned `user://` and non-drafted schemes never consult it. */
type MembershipResolver = (input: { projectId: ProjectId }) => Promise<{ members: string[] }>;

/** The registry key: a decoded canonical address resolved to storage coordinates. */
type Address = DocumentCoordinates;

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
      return {
        aheadId,
        address: addresses[index],
        awaitedDocumentId: registration.awaitedDocumentId ?? null,
      };
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
          resolved
            .filter((row) => !row.awaitedDocumentId)
            .map(({ address }) => ({ ...address, workId: address.lockWorkId })),
        );
        await lockAwaitedStripes(
          this.db,
          resolved.flatMap((row) => (row.awaitedDocumentId ? [row.awaitedDocumentId] : [])),
        );
        await this.registerResolved(resolved);
      }),
    );
  }

  async registerWithinTransaction(
    registrations: readonly Omit<AheadRegistration, "awaitedDocumentId">[],
  ): Promise<void> {
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
    const rows = resolved.map(({ aheadId, address, awaitedDocumentId }) => ({
      aheadId,
      awaitedDocumentId,
      projectId: address.projectId,
      scheme: address.scheme,
      workId: address.workId,
      rootThreadId: address.rootThreadId ?? null,
      path: address.path,
    }));
    const input = sql`jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as r(
      "aheadId" uuid, "awaitedDocumentId" uuid, "projectId" uuid, scheme text, "workId" uuid, "rootThreadId" uuid, path text)`;
    await tx.execute(sql`insert into link_ahead_refs (ahead_id, awaited_document_id, project_id, scheme, work_id, root_thread_id, path)
      select "aheadId", "awaitedDocumentId", "projectId", scheme, "workId", "rootThreadId", path from ${input}
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
        where r."awaitedDocumentId" is null and r."projectId" = coalesce(cs.project_id,w.project_id)
          and r."workId" is not distinct from (case when w.is_no_work then null else cs.work_id end)
          and r."rootThreadId" is not distinct from cs.root_thread_id
      )
      select d.id from requested r join documents d on d.id = r."awaitedDocumentId"
        join context_sources cs on cs.id = d.context_source_id left join works w on w.id = cs.work_id
        where coalesce(cs.project_id,w.project_id) = r."projectId" and d.deleted_at is null and d.kind = 'content'
      union
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
    await lockAwaitedStripes(this.db, documentIds);
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
    // Separate identity and address joins: an OR between them prevents the path/awaited
    // indexes (and hash joins) serving a vault with thousands of waiting refs.
    const matching = sql`
      select r.ahead_id, a."documentId" from addresses a join link_ahead_refs r
        on r.project_id = a."projectId" and r.scheme = a.scheme
          and md5(r.path) = md5(a.path) and r.path = a.path
          and r.work_id is not distinct from a."workId" and r.root_thread_id is not distinct from a."rootThreadId"
        where r.settled_document_id is null and r.awaited_document_id is null ${restricted}
      union all
      select r.ahead_id, a."documentId" from addresses a join link_ahead_refs r
        on r.awaited_document_id = a."documentId" and r.project_id = a."projectId"
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

  async releaseAwaiting(documentIds: readonly DocumentId[]): Promise<number> {
    const ids = [...new Set(documentIds)];
    if (ids.length === 0) return 0;
    const tx = currentDrizzleDb(this.db);
    // Release and an arrival meet at the address: an arrival that skipped a ref (it still
    // awaited another id) is invisible to us until it commits, so the address's namespace key
    // comes first, then the stripes, then the rows. Refs registered after this read hold
    // their key from registration on, not ours; Finish refuses to bind once it is terminal.
    const awaiting = await tx
      .selectDistinct({
        projectId: linkAheadRefs.projectId,
        scheme: linkAheadRefs.scheme,
        workId: linkAheadRefs.workId,
        rootThreadId: linkAheadRefs.rootThreadId,
      })
      .from(linkAheadRefs)
      .where(
        and(inArray(linkAheadRefs.awaitedDocumentId, ids), isNull(linkAheadRefs.settledDocumentId)),
      );
    // Registration's keys, rebuilt from the row: a ref with no Work and no chat lives in its
    // project's No Work namespace unless its scheme is project-scoped; `user` keys the owner.
    const projectIds = [...new Set(awaiting.map((row) => row.projectId))];
    const [owners, noWorks] = projectIds.length
      ? await Promise.all([
          tx
            .select({ id: projects.id, userId: projects.userId })
            .from(projects)
            .where(inArray(projects.id, projectIds)),
          tx
            .select({ id: works.id, projectId: works.projectId })
            .from(works)
            .where(
              and(
                inArray(works.projectId, projectIds),
                eq(works.isNoWork, true),
                isNull(works.deletedAt),
              ),
            ),
        ])
      : [[], []];
    const ownerOf = new Map(owners.map((row) => [row.id, row.userId]));
    const noWorkOf = new Map(noWorks.map((row) => [row.projectId, row.id]));
    await lockNamespaceKeys(
      this.db,
      awaiting.map((row) => ({
        projectId: row.projectId,
        userId: ownerOf.get(row.projectId) ?? "",
        scheme: row.scheme,
        workId:
          row.workId ??
          (row.rootThreadId || isProjectScopedScheme(row.scheme as ContextUriScheme)
            ? null
            : (noWorkOf.get(row.projectId) ?? null)),
      })),
    );
    await lockAwaitedStripes(this.db, ids);
    const released = await tx
      .update(linkAheadRefs)
      .set({ awaitedDocumentId: null })
      .where(
        and(inArray(linkAheadRefs.awaitedDocumentId, ids), isNull(linkAheadRefs.settledDocumentId)),
      )
      .returning();
    for (const row of released) {
      // As registration would: a document already at the address settles the ref now.
      const address: Address = {
        projectId: row.projectId,
        userId: "",
        scheme: row.scheme as ContextUriScheme,
        workId: row.workId,
        lockWorkId: row.workId,
        rootThreadId: row.rootThreadId,
        path: row.path,
      };
      const documentId = await this.liveDocumentAt(address);
      if (documentId) await this.settle(address, documentId, row.aheadId);
    }
    return released.length;
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

  /** A SQL row is not a live arrival while only a Work draft's manifest holds it (e4 §1). */
  private async isLive(address: Address, documentId: string): Promise<boolean> {
    if (!listsThroughLiveManifest(address.scheme)) return true;
    const { members } = await this.resolveManifestMembership({ projectId: address.projectId });
    return members.includes(documentId);
  }

  private async liveDocumentAt(address: Address): Promise<DocumentId | null> {
    const documentId = await documentAt(this.db, address);
    return documentId && (await this.isLive(address, documentId)) ? documentId : null;
  }

  /**
   * Which unsettled rows this document settles: the rows awaiting its id in its project,
   * wherever the ref was minted, and the rows awaiting nothing at its exact address.
   */
  private settlableBy(address: Address, documentId: string) {
    return or(
      and(
        eq(linkAheadRefs.awaitedDocumentId, documentId as DocumentId),
        eq(linkAheadRefs.projectId, address.projectId),
      ),
      and(isNull(linkAheadRefs.awaitedDocumentId), this.atAddress(address)),
    );
  }

  private atAddress(address: Address) {
    return and(
      eq(linkAheadRefs.projectId, address.projectId),
      eq(linkAheadRefs.scheme, address.scheme),
      address.workId === null
        ? isNull(linkAheadRefs.workId)
        : eq(linkAheadRefs.workId, address.workId),
      address.rootThreadId
        ? eq(linkAheadRefs.rootThreadId, address.rootThreadId)
        : isNull(linkAheadRefs.rootThreadId),
      // The index keys the path's md5 (unbounded paths overflow a B-tree tuple); exact recheck.
      sql`md5(${linkAheadRefs.path}) = md5(${address.path})`,
      eq(linkAheadRefs.path, address.path),
    );
  }

  /** Compare-and-set on `settled_document_id IS NULL`; at most one settler wins a row. */
  private async settle(address: Address, documentId: string, aheadId?: string): Promise<number> {
    const rows = await currentDrizzleDb(this.db)
      .update(linkAheadRefs)
      .set({ settledDocumentId: documentId, settledAt: new Date() })
      .where(
        and(
          isNull(linkAheadRefs.settledDocumentId),
          this.settlableBy(address, documentId),
          aheadId ? eq(linkAheadRefs.aheadId, aheadId) : undefined,
        ),
      )
      .returning({ id: linkAheadRefs.aheadId });
    return rows.length;
  }
}

/**
 * Awaiting stripes: a fixed few keys, so a bulk arrival never holds a lock per document.
 * Sorted, taken after every namespace key the caller needs.
 */
const AWAITED_STRIPES = 64;
const stripeOf = (documentId: string) =>
  Number.parseInt(documentId.replaceAll("-", "").slice(-4), 16) % AWAITED_STRIPES;
export const awaitedStripeKey = (documentId: string) =>
  `link-ahead-awaited:${stripeOf(documentId)}`;

/** Stripe keys each open transaction holds: a later call may not take a key below one held. */
const heldStripes = new WeakMap<object, Set<string>>();

async function lockAwaitedStripes(db: Database, documentIds: readonly string[]): Promise<void> {
  const tx = currentDrizzleDb(db);
  const keys = [...new Set(documentIds.map(awaitedStripeKey))].sort();
  let held: Set<string> | undefined;
  if (isInDrizzleTransaction()) {
    held = heldStripes.get(tx) ?? new Set<string>();
    heldStripes.set(tx, held);
    // Stripes last to commit, so order is per transaction: callers gather every arrival of
    // the transaction into one call. A violation is a caller bug, never retried around.
    const top = [...held].sort().at(-1);
    const late = keys.find((key) => !held?.has(key) && top !== undefined && key < top);
    if (late) throw new Error(`Awaited stripe ${late} taken after ${top}`);
  }
  if (keys.length)
    await tx.execute(sql`
    select pg_advisory_xact_lock(hashtextextended(key, 0::bigint))
    from (select value as key from jsonb_array_elements_text(${JSON.stringify(keys)}::jsonb) order by value) ordered`);
  for (const key of keys) held?.add(key);
}

export function createDrizzleLinkAheadRegistry(
  db: Database,
  resolveManifestMembership: MembershipResolver,
  eventSink?: EventSink,
): LinkAheadRegistry {
  return new DrizzleLinkAheadRegistry(db, resolveManifestMembership, eventSink);
}
