/**
 * Drizzle persistence for ahead-link identities (contract §9): durable rows minted
 * for addresses with no document yet, settled by the first live document that
 * arrives at the exact address (or at registration, if one is already there).
 */
import {
  type ContextUriScheme,
  isProjectScopedScheme,
  parseContextUri,
} from "@meridian/contracts/context-uri";
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
import { isDrafted } from "../../file-policy/index.js";
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
import { DrizzleContextTreeMutationStore } from "./context-fs/drizzle-tree-mutation-store.js";

/** Membership of the live manifest; `userId`-owned `user://` and non-drafted schemes never consult it. */
type MembershipResolver = (input: { projectId: ProjectId }) => Promise<{ members: string[] }>;

/** The registry key: a decoded canonical address resolved to storage coordinates. */
type Address = {
  projectId: ProjectId;
  userId: string;
  scheme: ContextUriScheme;
  /** Address coordinate: null for project-scoped schemes and for No Work. */
  workId: string | null;
  /** Lock coordinate: real arrivals lock a Work-scoped source by its persisted Work row, No Work included. */
  lockWorkId: string | null;
  path: string;
};

const sameAddress = (a: Address, b: Pick<Address, "projectId" | "scheme" | "workId" | "path">) =>
  a.projectId === b.projectId &&
  a.scheme === b.scheme &&
  a.workId === b.workId &&
  a.path === b.path;

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
          resolved.push({ aheadId, address: await this.resolveAddress(registration) });
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
          if (!row || !sameAddress(address, { ...row, scheme: row.scheme as ContextUriScheme })) {
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
      const address = await this.currentAddress(documentId);
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

  /** Decoded canonical address → (project, scheme, Work, path), as `document-link-rows.ts` does. */
  private async resolveAddress(registration: AheadRegistration): Promise<Address> {
    const parsed = parseContextUri(registration.address);
    if (!parsed.ok || parsed.value.normalized !== registration.address) {
      throw new RangeError(`Ahead-ref address is not canonical: ${registration.address}`);
    }
    const { scheme, authority, path } = parsed.value;
    // `.hidden` and `trailing.` have no real extension; tree lookup would parse them differently.
    if (!/^[^/]*[^/.][^/]*\.[^/.]+$/.test(path.split("/").at(-1) ?? "")) {
      throw new RangeError(`Ahead-ref address needs a file extension: ${registration.address}`);
    }
    // An ahead ref always carries a qualified absolute address.
    if (authority.kind === "contextual" && !isProjectScopedScheme(scheme)) {
      throw new RangeError(`Ahead-ref address needs a Work authority: ${registration.address}`);
    }
    const tx = currentDrizzleDb(this.db);
    const [holder] = await tx
      .select({ userId: projects.userId })
      .from(projects)
      .where(and(eq(projects.id, registration.holderProjectId), isNull(projects.deletedAt)));
    if (!holder) throw new Error(`Holder project ${registration.holderProjectId} does not exist`);

    let projectId = registration.holderProjectId;
    if (scheme === "user") {
      const [personal] = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.userId, holder.userId),
            eq(projects.isPersonal, true),
            isNull(projects.deletedAt),
          ),
        );
      if (!personal) throw new Error(`Personal project for ${holder.userId} does not exist`);
      projectId = personal.id as ProjectId;
    }

    let workId: string | null = null;
    let lockWorkId: string | null = null;
    if (authority.kind === "none") {
      const [noWork] = await tx
        .select({ id: works.id })
        .from(works)
        .where(
          and(
            eq(works.projectId, registration.holderProjectId),
            eq(works.isNoWork, true),
            isNull(works.deletedAt),
          ),
        );
      if (!noWork)
        throw new Error(`No Work row for ${registration.holderProjectId} does not exist`);
      lockWorkId = noWork.id;
    } else if (authority.kind === "work") {
      // Slugs stay reserved across soft deletion, so a deleted Work keeps its identity: the ref
      // registers against it and settles only once a restore makes the address live again.
      const [work] = await tx
        .select({ id: works.id })
        .from(works)
        .where(
          and(
            eq(works.projectId, registration.holderProjectId),
            eq(works.slug, authority.workSlug),
          ),
        );
      if (!work) throw new Error(`Work ${authority.workSlug} does not exist`);
      workId = lockWorkId = work.id;
    }
    return { projectId, userId: holder.userId, scheme, workId, lockWorkId, path };
  }

  /** The exact address a content document holds now, or null when deleted or unreachable. */
  private async currentAddress(documentId: DocumentId): Promise<Address | null> {
    const tx = currentDrizzleDb(this.db);
    const [row] = await tx
      .select({
        scheme: contextSources.slug,
        sourceProjectId: contextSources.projectId,
        sourceWorkId: contextSources.workId,
        workProjectId: works.projectId,
        workUserId: works.createdByUserId,
        isNoWork: works.isNoWork,
        projectUserId: projects.userId,
        folderId: documents.folderId,
        filename: sql<string>`${documents.name} || CASE WHEN ${documents.extension} = '' THEN '' ELSE '.' || ${documents.extension} END`,
      })
      .from(documents)
      .innerJoin(contextSources, eq(contextSources.id, documents.contextSourceId))
      .leftJoin(works, eq(works.id, contextSources.workId))
      .leftJoin(projects, eq(projects.id, contextSources.projectId))
      .where(
        and(
          eq(documents.id, documentId),
          eq(documents.kind, "content"),
          isNull(documents.deletedAt),
          isNull(contextSources.deletedAt),
        ),
      );
    const projectId = (row?.sourceProjectId ?? row?.workProjectId) as ProjectId | undefined;
    const userId = row?.projectUserId ?? row?.workUserId;
    if (!row || !projectId || !userId) return null;

    let path = row.filename;
    if (row.folderId) {
      // An ancestor folder that is deleted breaks the chain: the document has no address.
      const rows = await tx.execute<{ path: string }>(sql`
        WITH RECURSIVE up AS (
          SELECT parent_id, name AS path FROM folders
          WHERE id = ${row.folderId}::uuid AND deleted_at IS NULL
          UNION ALL
          SELECT f.parent_id, f.name || '/' || u.path FROM folders f
          JOIN up u ON f.id = u.parent_id WHERE f.deleted_at IS NULL
        )
        SELECT path FROM up WHERE parent_id IS NULL
      `);
      if (!rows[0]) return null;
      path = `${rows[0].path}/${path}`;
    }
    return {
      projectId,
      userId,
      scheme: row.scheme as ContextUriScheme,
      workId: row.sourceWorkId && !row.isNoWork ? row.sourceWorkId : null,
      lockWorkId: row.sourceWorkId,
      path,
    };
  }

  /** A SQL row is not a live arrival while only a Work draft's manifest holds it (e4 §1). */
  private async isLive(address: Address, documentId: string): Promise<boolean> {
    if (!isDrafted(address.scheme) || address.scheme === "user") return true;
    const { members } = await this.resolveManifestMembership({ projectId: address.projectId });
    return members.includes(documentId);
  }

  private async liveDocumentAt(address: Address): Promise<DocumentId | null> {
    const tx = currentDrizzleDb(this.db);
    const workScoped = !isProjectScopedScheme(address.scheme);
    const [source] = await tx
      .select({ id: contextSources.id })
      .from(contextSources)
      .leftJoin(works, eq(works.id, contextSources.workId))
      .where(
        and(
          eq(contextSources.slug, address.scheme),
          isNull(contextSources.deletedAt),
          workScoped
            ? and(
                eq(works.projectId, address.projectId),
                isNull(works.deletedAt),
                address.workId ? eq(works.id, address.workId) : eq(works.isNoWork, true),
              )
            : and(eq(contextSources.projectId, address.projectId), isNull(contextSources.workId)),
        ),
      );
    if (!source) return null;
    const node = await new DrizzleContextTreeMutationStore(this.db).inspect(
      source.id,
      address.path,
    );
    if (node?.kind !== "file") return null;
    const documentId = node.nodeId as DocumentId;
    // Tree lookup parses filenames loosely; settle only when the occupant renders this exact key.
    const occupant = await this.currentAddress(documentId);
    if (!occupant || !sameAddress(occupant, address)) return null;
    return (await this.isLive(address, documentId)) ? documentId : null;
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
