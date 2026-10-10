/**
 * Drizzle persistence for ahead-link identities (contract §9): durable rows minted
 * for addresses with no document yet, settled by the first live document that
 * arrives at the exact address (or at registration, if one is already there), and,
 * for a ref written in a draft, by that draft's occupant in its own view (§10.5).
 */
import type { DraftId } from "@meridian/contracts";
import type { ContextUriScheme } from "@meridian/contracts/context-uri";
import { parseRequestId } from "@meridian/contracts/request-id";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  contextSources,
  documentLinks,
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
import type { Drafts } from "../../collab/domain/drafts.js";
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
  UnregistrableAheadRefError,
} from "../ports/link-ahead-registry.js";
import type { DocumentCoordinates } from "../tree/tree-addresses.js";
import { createTreeReader, LIVE_TREE, visibleDocuments } from "../tree/tree-view.js";
import { lockNamespaceKeys } from "./context-fs/document-locations.js";
import {
  currentDocumentAddress,
  resolveCanonicalAddress,
  sameCoordinates,
  UnresolvableAddressError,
} from "./document-address.js";
import { atAddress, settleRegisteredInDrafts } from "./link-ahead-draft-settlements.js";

/** The registry key: a decoded canonical address resolved to storage coordinates. */
type Address = DocumentCoordinates;
export type LinkAheadRegistryDeps = {
  /** Registration relies on a named draft staying active while it settles there. */
  drafts: Pick<Drafts, "shareActive">;
  eventSink?: EventSink;
};

export class DrizzleLinkAheadRegistry implements LinkAheadRegistry {
  private readonly eventSink: EventSink;

  constructor(
    private readonly db: Database,
    private readonly deps: LinkAheadRegistryDeps,
  ) {
    this.eventSink = deps.eventSink ?? createNoopEventSink();
  }

  async register(registrations: readonly AheadRegistration[]): Promise<void> {
    if (isInDrizzleTransaction()) throw new RegistrationInsideTransactionError();
    if (registrations.length === 0) return;
    await runOutsideWrite(() =>
      runInRootDrizzleTransaction(this.db, async () => {
        const tx = currentDrizzleDb(this.db);
        // Each draft before any namespace key (lock order rule 4). FOR SHARE waits out a
        // close in progress, so no settlement can outlive the draft it names (O-12).
        const active = new Set<DraftId>();
        for (const draftId of [
          ...new Set(registrations.flatMap((each) => (each.draftId ? [each.draftId] : []))),
        ].sort()) {
          if (await this.deps.drafts.shareActive(draftId)) active.add(draftId);
        }
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
            address: await resolveCanonicalAddress(this.db, registration).catch(
              (cause: unknown) => {
                if (!(cause instanceof UnresolvableAddressError)) throw cause;
                throw new UnregistrableAheadRefError(aheadId, registration.address, cause.message, {
                  cause,
                });
              },
            ),
            draftId:
              registration.draftId && active.has(registration.draftId)
                ? registration.draftId
                : null,
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
              rootThreadId: address.rootThreadId ?? null,
              path: address.path,
            })),
          )
          .onConflictDoNothing({ target: linkAheadRefs.aheadId });
        // After the insert: whichever registration owns an id, it keeps its first address
        // for good, so another address is refused permanently.
        const stored = new Map(
          (await tx.select().from(linkAheadRefs).where(inArray(linkAheadRefs.aheadId, ids))).map(
            (row) => [row.aheadId, row],
          ),
        );
        for (const { aheadId, address, requested } of resolved) {
          const row = stored.get(aheadId);
          if (!row) throw new Error(`Ahead ref ${aheadId} has no row after its insert`);
          if (!sameCoordinates(address, { ...row, scheme: row.scheme as ContextUriScheme })) {
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
        // What each ref means in its draft is the settlement module's to decide and write.
        await settleRegisteredInDrafts(
          this.db,
          resolved.flatMap(({ aheadId, address, draftId }) =>
            draftId ? [{ aheadId, draftId, address }] : [],
          ),
        );
      }),
    );
  }

  async settleArrivals(documentIds: readonly DocumentId[]): Promise<number> {
    let settled = 0;
    for (const documentId of new Set(documentIds)) {
      const address = await currentDocumentAddress(this.db, documentId);
      // Every arrival calls this; the visibility read is paid only when a ref waits here.
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
    const documents = visibleDocuments(LIVE_TREE);
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

  private async isLive(_address: Address, documentId: string): Promise<boolean> {
    return (
      (await createTreeReader(this.db).findById(LIVE_TREE, documentId as DocumentId)).kind ===
      "found"
    );
  }

  private async liveDocumentAt(address: Address): Promise<DocumentId | null> {
    const occupants = await createTreeReader(this.db).occupantsAt(LIVE_TREE, [address]);
    const ids = [...occupants.values()][0] ?? [];
    return ids.length === 1 ? (ids[0] ?? null) : null;
  }

  private async hasUnsettled(address: Address): Promise<boolean> {
    const [row] = await currentDrizzleDb(this.db)
      .select({ id: linkAheadRefs.aheadId })
      .from(linkAheadRefs)
      .where(and(atAddress(address), isNull(linkAheadRefs.settledDocumentId)))
      .limit(1);
    return Boolean(row);
  }

  /** Compare-and-set on `settled_document_id IS NULL`; at most one settler wins a row. */
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
