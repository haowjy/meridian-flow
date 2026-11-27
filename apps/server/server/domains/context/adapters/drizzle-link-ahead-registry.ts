import type { ContextSourceId } from "@meridian/contracts";
import type { ContextUriScheme } from "@meridian/contracts/context-uri";
import { parseRequestId } from "@meridian/contracts/request-id";
import type { DocumentId, ProjectId, UserId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { documentLinks, documents, linkAheadRefs } from "@meridian/database/schema";
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
  type AheadHolder,
  type AheadRecoveryPage,
  type AheadRecoveryProgress,
  type AheadRecoveryScope,
  type AheadRegistration,
  type LinkAheadRegistry,
  RegistrationInsideTransactionError,
  UnregistrableAheadRefError,
} from "../ports/link-ahead-registry.js";
import { ownerColumns, ownerFrom } from "../tree/source-owner.js";
import {
  type DocumentCoordinates,
  loadDocumentAddresses,
  presentSourceId,
} from "../tree/tree-addresses.js";
import { createTreeReader, LIVE_TREE } from "../tree/tree-view.js";
import { assertNamespaceKeysHeld, lockNamespaceKeys } from "./context-fs/document-locations.js";
import {
  resolveCanonicalAddress,
  sameCoordinates,
  UnresolvableAddressError,
} from "./document-address.js";

type Address = DocumentCoordinates;
export type LinkAheadRegistryDeps = { eventSink?: EventSink };

function atAddress(address: Address) {
  return and(
    address.owner.kind === "project"
      ? eq(linkAheadRefs.projectId, address.owner.projectId as ProjectId)
      : eq(linkAheadRefs.userId, address.owner.userId as UserId),
    eq(linkAheadRefs.scheme, address.scheme),
    address.workId === null
      ? isNull(linkAheadRefs.workId)
      : eq(linkAheadRefs.workId, address.workId),
    address.rootThreadId
      ? eq(linkAheadRefs.rootThreadId, address.rootThreadId)
      : isNull(linkAheadRefs.rootThreadId),
    address.chatThreadId
      ? eq(linkAheadRefs.chatThreadId, address.chatThreadId)
      : isNull(linkAheadRefs.chatThreadId),
    // The index keys the path's md5 (unbounded paths overflow a B-tree tuple); exact recheck.
    sql`md5(${linkAheadRefs.path}) = md5(${address.path})`,
    eq(linkAheadRefs.path, address.path),
  );
}

export class DrizzleLinkAheadRegistry implements LinkAheadRegistry {
  private readonly eventSink: EventSink;

  constructor(
    private readonly db: Database,
    readonly deps: LinkAheadRegistryDeps,
  ) {
    this.eventSink = deps.eventSink ?? createNoopEventSink();
  }

  private async resolveRegistrations(registrations: readonly AheadRegistration[]) {
    const resolved = [];
    for (const registration of registrations) {
      const aheadId = parseRequestId(registration.aheadId);
      if (!aheadId) {
        throw new UnregistrableAheadRefError(
          registration.aheadId,
          registration.address,
          `Invalid ahead id: ${registration.aheadId}`,
        );
      }
      resolved.push({
        aheadId,
        requested: registration.address,
        address: await resolveCanonicalAddress(currentDrizzleDb(this.db), registration).catch(
          (cause: unknown) => {
            if (!(cause instanceof UnresolvableAddressError)) throw cause;
            throw new UnregistrableAheadRefError(aheadId, registration.address, cause.message, {
              cause,
            });
          },
        ),
      });
    }
    return resolved;
  }

  private async registerResolved(
    resolved: Awaited<ReturnType<DrizzleLinkAheadRegistry["resolveRegistrations"]>>,
  ): Promise<void> {
    const tx = currentDrizzleDb(this.db);
    const ids = resolved.map(({ aheadId }) => aheadId);
    await tx
      .insert(linkAheadRefs)
      .values(
        resolved.map(({ aheadId, address }) => ({
          aheadId,
          ...(ownerColumns(address.owner) as {
            projectId: ProjectId | null;
            userId: UserId | null;
          }),
          scheme: address.scheme,
          workId: address.workId,
          rootThreadId: address.rootThreadId,
          chatThreadId: address.chatThreadId,
          path: address.path,
        })),
      )
      .onConflictDoNothing({ target: linkAheadRefs.aheadId });
    const stored = new Map(
      (await tx.select().from(linkAheadRefs).where(inArray(linkAheadRefs.aheadId, ids))).map(
        (row) => [row.aheadId, row],
      ),
    );
    for (const { aheadId, address, requested } of resolved) {
      const row = stored.get(aheadId);
      if (!row) throw new Error(`Ahead ref ${aheadId} has no row after its insert`);
      const held = { ...row, owner: ownerFrom(row), scheme: row.scheme as ContextUriScheme };
      if (!sameCoordinates(address, held)) {
        throw new UnregistrableAheadRefError(
          aheadId,
          requested,
          `Ahead ref ${aheadId} was registered for another address`,
        );
      }
    }
    for (const { aheadId, address } of resolved) {
      const documentId = await this.liveDocumentAt(address);
      if (documentId) await this.settle(address, documentId, aheadId);
    }
  }

  async register(registrations: readonly AheadRegistration[]): Promise<void> {
    if (isInDrizzleTransaction()) throw new RegistrationInsideTransactionError();
    if (registrations.length === 0) return;
    await runOutsideWrite(() =>
      runInRootDrizzleTransaction(this.db, () => this.lockAndRegister(registrations)),
    );
  }

  async registerInCommand(registrations: readonly AheadRegistration[]): Promise<void> {
    if (!isInDrizzleTransaction())
      throw new Error("registerInCommand requires a command transaction");
    if (registrations.length === 0) return;
    await this.lockAndRegister(registrations);
  }

  private async lockAndRegister(registrations: readonly AheadRegistration[]): Promise<void> {
    const resolved = await this.resolveRegistrations(registrations);
    await lockNamespaceKeys(
      this.db,
      resolved.map(({ address }) => ({ ...address, workId: address.lockWorkId })),
    );
    await this.registerResolved(resolved);
  }

  async registerWithinTransaction(registrations: readonly AheadRegistration[]): Promise<void> {
    if (registrations.length === 0) return;
    const resolved = await this.resolveRegistrations(registrations);
    assertNamespaceKeysHeld(
      resolved.map(({ address }) => ({ ...address, workId: address.lockWorkId })),
    );
    await this.registerResolved(resolved);
  }

  async settleArrivals(documentIds: readonly DocumentId[]): Promise<number> {
    const addresses = (
      await loadDocumentAddresses(currentDrizzleDb(this.db), {
        ids: [...new Set(documentIds)],
      })
    ).filter((address) => !address.deleted);
    if (addresses.length === 0) return 0;
    const arrivals = addresses.map((address) => ({
      document_id: address.documentId,
      source_id: address.contextSourceId,
      project_id: ownerColumns(address.owner).projectId,
      user_id: ownerColumns(address.owner).userId,
      scheme: address.scheme,
      work_id: address.workId,
      root_thread_id: address.rootThreadId ?? null,
      chat_thread_id: address.chatThreadId ?? null,
    }));
    const pending = await currentDrizzleDb(this.db).execute<{
      ahead_id: string;
      path: string;
      document_id: string;
      source_id: string;
    }>(sql`
      with arrivals as (
        select * from jsonb_to_recordset(${JSON.stringify(arrivals)}::jsonb) as a(
          document_id uuid, source_id uuid, project_id uuid, user_id uuid, scheme text,
          work_id uuid, root_thread_id uuid, chat_thread_id uuid
        )
      )
      select r.ahead_id::text, r.path, a.document_id::text, a.source_id::text
      from link_ahead_refs r join arrivals a
        on r.project_id is not distinct from a.project_id
        and r.user_id is not distinct from a.user_id and r.scheme = a.scheme
        and r.work_id is not distinct from a.work_id
        and r.root_thread_id is not distinct from a.root_thread_id
        and r.chat_thread_id is not distinct from a.chat_thread_id
      where r.settled_document_id is null`);
    if (pending.length === 0) return 0;
    const reached = await createTreeReader(this.db).resolveDocumentAddresses(
      LIVE_TREE,
      pending.map((ref) => ({ contextSourceId: ref.source_id as ContextSourceId, path: ref.path })),
    );
    const settled = new Map<string, string>();
    pending.forEach((ref, index) => {
      const answer = reached[index];
      if (answer?.kind === "found" && answer.node.kind === "document") {
        if (answer.node.document.id === ref.document_id) settled.set(ref.ahead_id, ref.document_id);
      }
    });
    if (settled.size === 0) return 0;
    const [result] = await currentDrizzleDb(this.db).execute<{ count: number }>(sql`
      with settled as (
        update link_ahead_refs r set settled_document_id = s.document_id, settled_at = now()
        from jsonb_to_recordset(${JSON.stringify(
          [...settled].map(([ahead_id, document_id]) => ({ ahead_id, document_id })),
        )}::jsonb) as s(ahead_id uuid, document_id uuid)
        where r.ahead_id = s.ahead_id and r.settled_document_id is null
        returning r.ahead_id
      ) select count(*)::integer as count from settled`);
    return result?.count ?? 0;
  }

  async registerUnregistered(
    scope: AheadRecoveryScope | undefined,
    page: AheadRecoveryPage,
  ): Promise<AheadRecoveryProgress> {
    if (isInDrizzleTransaction()) throw new RegistrationInsideTransactionError();
    const pending = await this.db
      .selectDistinctOn([documentLinks.aheadId], {
        aheadId: documentLinks.aheadId,
        address: documentLinks.address,
        holderProjectId: documents.projectId,
        holderUserId: documents.userId,
      })
      .from(documentLinks)
      .innerJoin(documents, eq(documents.id, documentLinks.sourceDocumentId))
      .leftJoin(linkAheadRefs, eq(linkAheadRefs.aheadId, documentLinks.aheadId))
      .where(
        and(
          isNull(documents.inNoViewSince),
          isNotNull(documentLinks.aheadId),
          isNotNull(documentLinks.address),
          isNull(linkAheadRefs.aheadId),
          scope === undefined ? undefined : eq(documentLinks.sourceDocumentId, scope.documentId),
          page.after ? gt(documentLinks.aheadId, page.after) : undefined,
        ),
      )
      .orderBy(documentLinks.aheadId)
      .limit(page.limit);
    let registered = 0;
    for (const row of pending) {
      if (!row.aheadId || !row.address) continue;
      const holder: AheadHolder = row.holderProjectId
        ? { holderProjectId: row.holderProjectId }
        : { holderUserId: row.holderUserId as UserId };
      try {
        await this.register([{ aheadId: row.aheadId, address: row.address, ...holder }]);
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
    const last = pending.at(-1)?.aheadId;
    return { registered, next: pending.length === page.limit && last ? last : null };
  }

  private async liveDocumentAt(address: Address): Promise<DocumentId | null> {
    const contextSourceId = await presentSourceId(currentDrizzleDb(this.db), address);
    if (!contextSourceId) return null;
    const found = await createTreeReader(this.db).resolveDocumentAddress(LIVE_TREE, {
      contextSourceId,
      path: address.path,
    });
    return found.kind === "found" && found.node.kind === "document" ? found.node.document.id : null;
  }

  private async settle(address: Address, documentId: string, aheadId?: string): Promise<number> {
    const rows = await currentDrizzleDb(this.db)
      .update(linkAheadRefs)
      .set({ settledDocumentId: documentId, settledAt: new Date() })
      .where(
        and(
          atAddress(address),
          isNull(linkAheadRefs.settledDocumentId),
          aheadId ? eq(linkAheadRefs.aheadId, aheadId) : undefined,
        ),
      )
      .returning({ id: linkAheadRefs.aheadId });
    return rows.length;
  }
}

export function createDrizzleLinkAheadRegistry(
  db: Database,
  deps: LinkAheadRegistryDeps,
): LinkAheadRegistry {
  return new DrizzleLinkAheadRegistry(db, deps);
}
