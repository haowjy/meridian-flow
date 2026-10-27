/**
 * Drizzle persistence for ahead-link identities (contract §9): durable rows minted
 * for addresses with no document yet, settled by the first live document that
 * arrives at the exact address (or at registration, if one is already there). Binding
 * is global and once; branches store nothing about ahead refs.
 */
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
  UnregistrableAheadRefError,
} from "../ports/link-ahead-registry.js";
import { type DocumentCoordinates, loadDocumentAddresses } from "../tree/tree-addresses.js";
import { createTreeReader, LIVE_TREE, visibleDocuments } from "../tree/tree-view.js";
import { lockNamespaceKeys } from "./context-fs/document-locations.js";
import {
  resolveCanonicalAddress,
  sameCoordinates,
  UnresolvableAddressError,
} from "./document-address.js";

/** The registry key: a decoded canonical address resolved to storage coordinates. */
type Address = DocumentCoordinates;
export type LinkAheadRegistryDeps = { eventSink?: EventSink };

/** Addresses per statement when a bulk arrival looks for waiting refs. */
const ADDRESS_BATCH = 100;

/** One address's coordinates as a map key; the path is compared exactly, as `atAddress` does. */
function coordinateKey(address: {
  projectId: string;
  scheme: string;
  workId: string | null;
  rootThreadId?: string | null;
  chatThreadId?: string | null;
  path: string;
}): string {
  return JSON.stringify([
    address.projectId,
    address.scheme,
    address.workId,
    address.rootThreadId ?? null,
    address.chatThreadId ?? null,
    address.path,
  ]);
}

/** Registry rows at exactly this address. */
function atAddress(address: Address) {
  return and(
    eq(linkAheadRefs.projectId, address.projectId),
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

  async register(registrations: readonly AheadRegistration[]): Promise<void> {
    if (isInDrizzleTransaction()) throw new RegistrationInsideTransactionError();
    if (registrations.length === 0) return;
    await runOutsideWrite(() =>
      runInRootDrizzleTransaction(this.db, async () => {
        const tx = currentDrizzleDb(this.db);
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
              rootThreadId: address.rootThreadId,
              chatThreadId: address.chatThreadId,
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
      }),
    );
  }

  async settleArrivals(documentIds: readonly DocumentId[]): Promise<number> {
    const addresses = (
      await loadDocumentAddresses(this.db, { ids: [...new Set(documentIds)] })
    ).filter((address) => !address.deleted);
    // Every arrival calls this; the visibility read is paid only where a ref waits.
    let settled = 0;
    for (const address of await this.withUnsettledRefs(addresses)) {
      if (await this.isLive(address, address.documentId)) {
        settled += await this.settle(address, address.documentId);
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

  /** The addresses, of those given, where some ref still waits: a bulk arrival's one look. */
  private async withUnsettledRefs<A extends Address>(addresses: readonly A[]): Promise<A[]> {
    const waiting = new Set<string>();
    for (let offset = 0; offset < addresses.length; offset += ADDRESS_BATCH) {
      const rows = await currentDrizzleDb(this.db)
        .select({
          projectId: linkAheadRefs.projectId,
          scheme: linkAheadRefs.scheme,
          workId: linkAheadRefs.workId,
          rootThreadId: linkAheadRefs.rootThreadId,
          chatThreadId: linkAheadRefs.chatThreadId,
          path: linkAheadRefs.path,
        })
        .from(linkAheadRefs)
        .where(
          and(
            isNull(linkAheadRefs.settledDocumentId),
            or(...addresses.slice(offset, offset + ADDRESS_BATCH).map(atAddress)),
          ),
        );
      for (const row of rows) waiting.add(coordinateKey(row));
    }
    return addresses.filter((address) => waiting.has(coordinateKey(address)));
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
