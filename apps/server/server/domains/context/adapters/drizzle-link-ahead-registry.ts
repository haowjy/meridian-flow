/** Drizzle persistence for ahead-link identities and their first live arrival. */
import {
  type ContextUriScheme,
  isProjectScopedScheme,
  parseContextUri,
} from "@meridian/contracts/context-uri";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  contextSources,
  documents,
  folders,
  linkAheadRefs,
  projects,
  works,
} from "@meridian/database/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  currentDrizzleDb,
  isInDrizzleTransaction,
  runInRootDrizzleTransaction,
  runOutsideWrite,
} from "../../../shared/drizzle-transaction.js";
import { isDrafted } from "../../file-policy/index.js";
import {
  type AheadRegistration,
  type LinkAheadRegistry,
  RegistrationInsideTransactionError,
} from "../ports/link-ahead-registry.js";
import { type ContextNamespace, lockNamespaceKeys } from "./context-fs/document-locations.js";
import { DrizzleContextTreeMutationStore } from "./context-fs/drizzle-tree-mutation-store.js";

type MembershipResolver = (input: {
  projectId: ProjectId;
  workId?: string | null;
}) => Promise<{ members: string[] }>;

type AddressTarget = {
  projectId: ProjectId;
  userId: string;
  scheme: ContextUriScheme;
  workId: string | null;
  path: string;
};

type Arrival = {
  id: DocumentId;
  sourceId: string;
  target: AddressTarget;
};

function aheadUuid(value: string): string {
  const raw = value.startsWith("ahead:") ? value.slice("ahead:".length) : value;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)) {
    throw new RangeError(`Invalid ahead ref: ${value}`);
  }
  return raw;
}

function canonicalPath(path: string): string {
  const filename = path.split("/").at(-1) ?? "";
  if (!filename.includes(".")) throw new RangeError("Ahead-ref addresses require a file extension");
  return path;
}

export class DrizzleLinkAheadRegistry implements LinkAheadRegistry {
  constructor(
    private readonly db: Database,
    private readonly options: { resolveManifestMembership?: MembershipResolver } = {},
  ) {}

  async register(registrations: readonly AheadRegistration[]): Promise<void> {
    if (isInDrizzleTransaction()) throw new RegistrationInsideTransactionError();
    await runOutsideWrite(() =>
      runInRootDrizzleTransaction(this.db, async () => {
        const tx = currentDrizzleDb(this.db);
        const resolved = await this.resolveRegistrations(tx as Database, registrations);
        if (resolved.length === 0) return;

        const namespaces: ContextNamespace[] = resolved.map(({ target }) => ({
          projectId: target.projectId,
          userId: target.userId,
          scheme: target.scheme,
          workId: target.workId,
        }));
        await lockNamespaceKeys(tx as Database, namespaces);

        const ids = resolved.map(({ aheadId }) => aheadId);
        const existing = await tx
          .select({
            aheadId: linkAheadRefs.aheadId,
            projectId: linkAheadRefs.projectId,
            scheme: linkAheadRefs.scheme,
            workId: linkAheadRefs.workId,
            path: linkAheadRefs.path,
          })
          .from(linkAheadRefs)
          .where(inArray(linkAheadRefs.aheadId, ids));
        const existingById = new Map(existing.map((row) => [row.aheadId, row]));
        for (const item of resolved) {
          const prior = existingById.get(item.aheadId);
          if (
            prior &&
            (prior.projectId !== item.target.projectId ||
              prior.scheme !== item.target.scheme ||
              prior.workId !== item.target.workId ||
              prior.path !== item.target.path)
          ) {
            throw new Error(
              `Ahead ref ${item.registration.aheadId} was registered for another address`,
            );
          }
        }

        const missing = resolved.filter(({ aheadId }) => !existingById.has(aheadId));
        if (missing.length > 0) {
          await tx
            .insert(linkAheadRefs)
            .values(
              missing.map(({ aheadId, target }) => ({
                aheadId,
                projectId: target.projectId,
                scheme: target.scheme,
                workId: target.workId,
                path: target.path,
              })),
            )
            .onConflictDoNothing({ target: linkAheadRefs.aheadId });
        }

        // A concurrent registration can win the UUID conflict after the
        // initial read. Re-read before settling so that mismatched reuse is
        // rejected even in that race.
        const persisted = await tx
          .select({
            aheadId: linkAheadRefs.aheadId,
            projectId: linkAheadRefs.projectId,
            scheme: linkAheadRefs.scheme,
            workId: linkAheadRefs.workId,
            path: linkAheadRefs.path,
          })
          .from(linkAheadRefs)
          .where(inArray(linkAheadRefs.aheadId, ids));
        const persistedById = new Map(persisted.map((row) => [row.aheadId, row]));
        for (const item of resolved) {
          const prior = persistedById.get(item.aheadId);
          if (
            !prior ||
            prior.projectId !== item.target.projectId ||
            prior.scheme !== item.target.scheme ||
            prior.workId !== item.target.workId ||
            prior.path !== item.target.path
          ) {
            throw new Error(
              `Ahead ref ${item.registration.aheadId} was registered for another address`,
            );
          }
        }

        for (const { aheadId, target } of resolved) {
          const documentId = await this.liveDocumentAt(tx as Database, target);
          if (documentId) await this.settleAddress(tx as Database, aheadId, target, documentId);
        }
      }),
    );
  }

  async settleArrivals(documentIds: readonly DocumentId[]): Promise<number> {
    const tx = currentDrizzleDb(this.db);
    let settled = 0;
    for (const documentId of [...new Set(documentIds)]) {
      const arrival = await this.readArrival(tx as Database, documentId);
      if (!arrival || !(await this.isLiveArrival(arrival))) continue;
      settled += await this.settleAddress(tx as Database, null, arrival.target, arrival.id);
    }
    return settled;
  }

  private async resolveRegistrations(
    tx: Database,
    registrations: readonly AheadRegistration[],
  ): Promise<Array<{ registration: AheadRegistration; aheadId: string; target: AddressTarget }>> {
    const resolved = [] as Array<{
      registration: AheadRegistration;
      aheadId: string;
      target: AddressTarget;
    }>;
    const byId = new Map<string, string>();
    for (const registration of registrations) {
      const aheadId = aheadUuid(registration.aheadId);
      const parsed = parseContextUri(registration.address);
      if (!parsed.ok) throw new RangeError(`Invalid ahead-ref address: ${registration.address}`);
      canonicalPath(parsed.value.path);
      const address = parsed.value.normalized;
      if (address !== registration.address) {
        throw new RangeError(`Ahead-ref address is not canonical: ${registration.address}`);
      }
      const priorAddress = byId.get(aheadId);
      if (priorAddress && priorAddress !== address)
        throw new Error(`Ahead ref ${registration.aheadId} was registered for another address`);
      byId.set(aheadId, address);
      const target = await this.resolveAddress(tx, registration.holderProjectId, parsed.value);
      resolved.push({ registration, aheadId, target });
    }
    return resolved;
  }

  private async resolveAddress(
    tx: Database,
    holderProjectId: ProjectId,
    parsed: {
      scheme: ContextUriScheme;
      authority: { kind: string; workSlug?: string };
      path: string;
    },
  ): Promise<AddressTarget> {
    const [holder] = await tx
      .select({ userId: projects.userId })
      .from(projects)
      .where(and(eq(projects.id, holderProjectId), isNull(projects.deletedAt)))
      .limit(1);
    if (!holder) throw new Error(`Holder project ${holderProjectId} does not exist`);

    let projectId = holderProjectId;
    let userId = holder.userId;
    if (parsed.scheme === "user") {
      const [personal] = await tx
        .select({ id: projects.id, userId: projects.userId })
        .from(projects)
        .where(
          and(
            eq(projects.userId, holder.userId),
            eq(projects.isPersonal, true),
            isNull(projects.deletedAt),
          ),
        )
        .limit(1);
      if (!personal) throw new Error(`Personal project for ${holder.userId} does not exist`);
      projectId = personal.id as ProjectId;
      userId = personal.userId;
    }

    let workId: string | null = null;
    if (parsed.authority.kind === "work") {
      const [work] = await tx
        .select({ id: works.id })
        .from(works)
        .where(
          and(
            eq(works.projectId, holderProjectId),
            eq(works.slug, parsed.authority.workSlug ?? ""),
            isNull(works.deletedAt),
          ),
        )
        .limit(1);
      if (!work) throw new Error(`Work ${parsed.authority.workSlug ?? ""} does not exist`);
      workId = work.id;
    }
    return { projectId, userId, scheme: parsed.scheme, workId, path: parsed.path };
  }

  private async readArrival(tx: Database, documentId: DocumentId): Promise<Arrival | null> {
    const [row] = await tx
      .select({
        id: documents.id,
        sourceId: contextSources.id,
        scheme: contextSources.slug,
        sourceProjectId: contextSources.projectId,
        sourceWorkId: contextSources.workId,
        sourceDeletedAt: contextSources.deletedAt,
        documentDeletedAt: documents.deletedAt,
        kind: documents.kind,
        name: documents.name,
        extension: documents.extension,
        folderId: documents.folderId,
        workProjectId: works.projectId,
        workUserId: works.createdByUserId,
        workIsNoWork: works.isNoWork,
        projectUserId: projects.userId,
      })
      .from(documents)
      .innerJoin(contextSources, eq(contextSources.id, documents.contextSourceId))
      .leftJoin(works, eq(works.id, contextSources.workId))
      .leftJoin(projects, eq(projects.id, contextSources.projectId))
      .where(eq(documents.id, documentId))
      .limit(1);
    if (
      row?.kind !== "content" ||
      row.documentDeletedAt ||
      row.sourceDeletedAt ||
      (row.sourceWorkId && !row.workProjectId)
    )
      return null;
    const projectId = (row.sourceProjectId ?? row.workProjectId) as ProjectId | null;
    const userId = row.projectUserId ?? row.workUserId;
    if (!projectId || !userId) return null;
    const path = await this.folderPath(tx, row.folderId, row.name, row.extension);
    const workId = row.sourceWorkId && !row.workIsNoWork ? row.sourceWorkId : null;
    const target: AddressTarget = {
      projectId,
      userId,
      scheme: row.scheme as ContextUriScheme,
      workId,
      path,
    };
    return { id: row.id as DocumentId, sourceId: row.sourceId, target };
  }

  private async folderPath(
    tx: Database,
    folderId: string | null,
    name: string,
    extension: string,
  ): Promise<string> {
    const names = [extension ? `${name}.${extension}` : name];
    let current = folderId;
    while (current) {
      const [folder] = await tx
        .select({ parentId: folders.parentId, name: folders.name, deletedAt: folders.deletedAt })
        .from(folders)
        .where(eq(folders.id, current))
        .limit(1);
      if (!folder || folder.deletedAt) return names.join("/");
      names.unshift(folder.name);
      current = folder.parentId;
    }
    return names.join("/");
  }

  private async isLiveArrival(arrival: Arrival): Promise<boolean> {
    const scheme = arrival.target.scheme;
    // Work-drafted project sources have a branch membership in addition to a
    // row in the tree. A missing membership resolver is used by focused unit
    // fixtures that do not compose the collab domain.
    if (isDrafted(scheme) && scheme !== "user" && this.options.resolveManifestMembership) {
      try {
        const membership = await this.options.resolveManifestMembership({
          projectId: arrival.target.projectId,
        });
        if (!membership.members.includes(arrival.id)) return false;
      } catch {
        return false;
      }
    }
    const current = await new DrizzleContextTreeMutationStore(this.db).inspect(
      arrival.sourceId,
      arrival.target.path,
    );
    return current?.kind === "file" && current.nodeId === arrival.id;
  }

  private async liveDocumentAt(tx: Database, target: AddressTarget): Promise<DocumentId | null> {
    const sourceId = await this.sourceIdAt(tx, target);
    if (!sourceId) return null;
    const current = await new DrizzleContextTreeMutationStore(this.db).inspect(
      sourceId,
      target.path,
    );
    if (current?.kind !== "file") return null;
    const arrival = await this.readArrival(tx, current.nodeId as DocumentId);
    if (!arrival || !(await this.isLiveArrival(arrival))) return null;
    return arrival.id;
  }

  private async sourceIdAt(tx: Database, target: AddressTarget): Promise<string | null> {
    const workScoped = !isProjectScopedScheme(target.scheme);
    const [source] = await tx
      .select({ id: contextSources.id })
      .from(contextSources)
      .leftJoin(works, eq(works.id, contextSources.workId))
      .where(
        and(
          eq(contextSources.slug, target.scheme),
          isNull(contextSources.deletedAt),
          workScoped
            ? and(
                eq(works.projectId, target.projectId),
                isNull(works.deletedAt),
                target.workId ? eq(contextSources.workId, target.workId) : eq(works.isNoWork, true),
              )
            : and(eq(contextSources.projectId, target.projectId), isNull(contextSources.workId)),
        ),
      )
      .limit(1);
    return source?.id ?? null;
  }

  private async settleAddress(
    tx: Database,
    aheadId: string | null,
    target: AddressTarget,
    documentId: DocumentId,
  ): Promise<number> {
    const condition = and(
      eq(linkAheadRefs.projectId, target.projectId),
      eq(linkAheadRefs.scheme, target.scheme),
      target.workId === null
        ? isNull(linkAheadRefs.workId)
        : eq(linkAheadRefs.workId, target.workId),
      eq(linkAheadRefs.path, target.path),
      isNull(linkAheadRefs.settledDocumentId),
      aheadId ? eq(linkAheadRefs.aheadId, aheadId) : undefined,
    );
    const rows = await tx
      .update(linkAheadRefs)
      .set({ settledDocumentId: documentId, settledAt: new Date() })
      .where(condition)
      .returning({ id: linkAheadRefs.aheadId });
    return rows.length;
  }
}

export function createDrizzleLinkAheadRegistry(
  db: Database,
  options: { resolveManifestMembership?: MembershipResolver } = {},
): LinkAheadRegistry {
  return new DrizzleLinkAheadRegistry(db, options);
}

export { RegistrationInsideTransactionError } from "../ports/link-ahead-registry.js";
