/**
 * Drizzle persistence for ahead-link identities (contract §9): durable rows minted
 * for addresses with no document yet, settled by the first live document that
 * arrives at the exact address (or at registration, if one is already there).
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
import { lockNamespaceKeys } from "./context-fs/document-locations.js";
import {
  currentDocumentAddress,
  type DocumentCoordinates,
  documentAt,
  listsThroughLiveManifest,
  resolveCanonicalAddress,
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

  async register(registrations: readonly AheadRegistration[]): Promise<void> {
    if (isInDrizzleTransaction()) throw new RegistrationInsideTransactionError();
    if (registrations.length === 0) return;
    await runOutsideWrite(() =>
      runInRootDrizzleTransaction(this.db, async () => {
        const tx = currentDrizzleDb(this.db);
        const resolved = [];
        for (const registration of registrations) {
          const aheadId = parseRequestId(registration.aheadId);
          if (!aheadId) throw new RangeError(`Invalid ahead id: ${registration.aheadId}`);
          resolved.push({
            aheadId,
            address: await resolveCanonicalAddress(this.db, registration),
          });
        }
        // Namespace keys only: registration is not an authored write (archived Work
        // scratch is a valid target) and holds nothing else, so it cannot close a cycle.
        await lockNamespaceKeys(
          this.db,
          resolved.map(({ address }) => ({ ...address, workId: address.lockWorkId })),
        );

        const ids = resolved.map(({ aheadId }) => aheadId);
        await tx
          .insert(linkAheadRefs)
          .values(
            resolved.map(({ aheadId, address }) => ({
              aheadId,
              projectId: address.projectId,
              scheme: address.scheme,
              workId: address.workId,
              path: address.path,
            })),
          )
          .onConflictDoNothing({ target: linkAheadRefs.aheadId });
        // After the insert: whichever registration owns an id, a different address is a bug.
        const stored = new Map(
          (await tx.select().from(linkAheadRefs).where(inArray(linkAheadRefs.aheadId, ids))).map(
            (row) => [row.aheadId, row],
          ),
        );
        for (const { aheadId, address } of resolved) {
          const row = stored.get(aheadId);
          if (
            !row ||
            !sameCoordinates(address, { ...row, scheme: row.scheme as ContextUriScheme })
          ) {
            throw new Error(`Ahead ref ${aheadId} was registered for another address`);
          }
        }

        for (const { aheadId, address } of resolved) {
          const documentId = await this.liveDocumentAt(address);
          if (documentId) await this.settle(address, documentId, aheadId);
        }
      }),
    );
  }

  async settleArrivals(documentIds: readonly DocumentId[]): Promise<number> {
    let settled = 0;
    for (const documentId of new Set(documentIds)) {
      const address = await currentDocumentAddress(this.db, documentId);
      // Every arrival calls this; the manifest read is paid only when a ref waits here.
      if (
        address &&
        (await this.hasUnsettled(address)) &&
        (await this.isLive(address, documentId))
      ) {
        settled += await this.settle(address, documentId);
      }
    }
    return settled;
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

  private async hasUnsettled(address: Address): Promise<boolean> {
    const [row] = await currentDrizzleDb(this.db)
      .select({ id: linkAheadRefs.aheadId })
      .from(linkAheadRefs)
      .where(and(this.atAddress(address), isNull(linkAheadRefs.settledDocumentId)))
      .limit(1);
    return Boolean(row);
  }

  private atAddress(address: Address) {
    return and(
      eq(linkAheadRefs.projectId, address.projectId),
      eq(linkAheadRefs.scheme, address.scheme),
      address.workId === null
        ? isNull(linkAheadRefs.workId)
        : eq(linkAheadRefs.workId, address.workId),
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
          this.atAddress(address),
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
  resolveManifestMembership: MembershipResolver,
  eventSink?: EventSink,
): LinkAheadRegistry {
  return new DrizzleLinkAheadRegistry(db, resolveManifestMembership, eventSink);
}
