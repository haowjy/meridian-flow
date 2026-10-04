/** Capture link identities before a namespace move, without editing holder content. */
import {
  documentAddressKey,
  matchDocumentPath,
  parseContextUri,
  resolveDocumentHref,
  respellDocumentHref,
  spellDocumentHref,
} from "@meridian/contracts";
import type { Database } from "@meridian/database";
import {
  contextSources,
  documentLinks,
  documents,
  linkRedirects,
  modelResponses,
  projects,
  works,
} from "@meridian/database/schema";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { createDrizzleProjectWorkAuthorityResolver } from "../../projects/index.js";
import { createDrizzleContextCatalog } from "../adapters/context-catalog.js";
import type { NamespaceLocation } from "../adapters/context-fs/document-locations.js";
import { createDocumentLinkResolver } from "../document-link-resolution.js";
import { resolveDocumentUri } from "../document-uri-resolver.js";
import type { ContextTreeMoveCommand } from "../ports/context-tree-mutation-store.js";

export async function recordMoveRedirects(
  db: Database,
  input: ContextTreeMoveCommand,
  previous: readonly NamespaceLocation[],
): Promise<{ links: number; documents: number }> {
  const tx = currentDrizzleDb(db);
  const moved = previous.filter((entry) => entry.kind === "file");
  if (!moved.length) return { links: 0, documents: 0 };
  const ids = moved.map((entry) => entry.id).sort();
  // NO KEY UPDATE is compatible with the journal's holder FK KEY SHARE.
  await tx
    .select({ id: documents.id })
    .from(documents)
    .where(inArray(documents.id, ids))
    .orderBy(documents.id)
    .for("no key update");
  await tx
    .select()
    .from(linkRedirects)
    .where(
      or(
        inArray(linkRedirects.sourceDocumentId, ids),
        inArray(linkRedirects.targetDocumentId, ids),
      ),
    )
    .orderBy(linkRedirects.sourceDocumentId, linkRedirects.href)
    .for("update");

  const authorities = createDrizzleProjectWorkAuthorityResolver(db);
  const catalog = createDrizzleContextCatalog(tx as Database);
  const resolver = createDocumentLinkResolver({ catalog, workAuthorityResolver: authorities });
  const uris = new Map<string, Promise<string | null>>();
  function uri(id: string) {
    let result = uris.get(id);
    if (!result) {
      result = resolveDocumentUri(tx, authorities, id);
      uris.set(id, result);
    }
    return result;
  }
  const [destination] = await tx
    .select({
      scheme: contextSources.slug,
      slug: works.slug,
      workId: works.id,
      projectId: contextSources.projectId,
      workProjectId: works.projectId,
    })
    .from(contextSources)
    .leftJoin(works, eq(works.id, contextSources.workId))
    .where(eq(contextSources.id, input.destinationSourceId));
  if (!destination) throw new Error("Move destination source missing");
  const destinationPrefix = `${destination.scheme}://${destination.workId ? `@${destination.slug ?? ""}/` : ""}`;
  const relocated = new Map<string, string>();
  for (const entry of moved)
    relocated.set(
      entry.id,
      destinationPrefix + input.destinationPath + entry.path.slice(input.source.path.length),
    );

  async function owner(id: string) {
    const [row] = await tx
      .select({
        projectId: projects.id,
        userId: projects.userId,
        workId: works.id,
        archivedAt: works.archivedAt,
        deletedAt: works.deletedAt,
        kind: documents.kind,
        documentDeletedAt: documents.deletedAt,
      })
      .from(documents)
      .innerJoin(contextSources, eq(documents.contextSourceId, contextSources.id))
      .leftJoin(works, eq(contextSources.workId, works.id))
      .innerJoin(
        projects,
        eq(projects.id, sql`coalesce(${contextSources.projectId}, ${works.projectId})`),
      )
      .where(eq(documents.id, id));
    return row;
  }
  const snapshots = new Map<string, Promise<Array<{ id: string; uri: string }>>>();
  async function candidates(projectId: string, userId: string, targetUri: string) {
    const parsed = parseContextUri(targetUri);
    if (!parsed.ok) return [];
    const p = parsed.value;
    const work =
      p.authority.kind === "work"
        ? await authorities.bySlug(projectId, p.authority.workSlug)
        : p.authority.kind === "none"
          ? await authorities.noWork(projectId)
          : null;
    const scope =
      p.scheme === "user"
        ? { kind: "user" as const, userId }
        : work
          ? { kind: "work" as const, projectId, workId: work.workId }
          : { kind: "project" as const, projectId };
    const key = JSON.stringify(scope);
    let result = snapshots.get(key);
    if (!result) {
      result = catalog
        .snapshot(scope)
        .then((snapshot) =>
          snapshot.entries.flatMap((entry) =>
            entry.kind === "file" ? [{ id: entry.entryId, uri: entry.uri }] : [],
          ),
        );
      snapshots.set(key, result);
    }
    return (await result).filter(
      (entry) => parseContextUri(entry.uri).ok && entry.uri.split("://")[0] === p.scheme,
    );
  }
  const targets = new Map<string, string>();
  const predicates = [];
  for (const entry of moved) {
    const oldUri = await uri(entry.id);
    const scope = await owner(entry.id);
    if (!oldUri || !scope) continue;
    const keys = [documentAddressKey(oldUri)];
    const dot = oldUri.lastIndexOf(".");
    if (dot > oldUri.lastIndexOf("/") + 1) {
      const short = oldUri.slice(0, dot);
      const files = await candidates(scope.projectId, scope.userId, oldUri);
      if (matchDocumentPath(files, short, (file) => file.uri)?.id === entry.id)
        keys.push(documentAddressKey(short));
    }
    for (const key of keys) targets.set(`${scope.projectId}:${key}`, entry.id);
    predicates.push(
      and(
        eq(documentLinks.targetProjectId, scope.projectId),
        inArray(documentLinks.targetKey, keys),
      ),
    );
  }
  const rows = await tx
    .select()
    .from(documentLinks)
    .where(or(...predicates, inArray(documentLinks.sourceDocumentId, ids)));
  const [response] = input.mover?.responseId
    ? await tx
        .select({ turnId: modelResponses.turnId })
        .from(modelResponses)
        .where(eq(modelResponses.id, input.mover.responseId))
    : [];
  const moverTurnId = input.mover?.turnId ?? response?.turnId ?? null;
  let links = 0;
  const holders = new Set<string>();
  for (const row of rows) {
    // Contextual links are deliberately viewer-dependent and never redirected.
    if (!row.targetKey || !row.targetProjectId) continue;
    const holderOld = await uri(row.sourceDocumentId);
    const scope = await owner(row.sourceDocumentId);
    if (!holderOld || !scope) continue;
    const relative = !/^[a-z][a-z0-9+.-]*:\/\//i.test(row.href);
    let targetId: string | null = targets.get(`${row.targetProjectId}:${row.targetKey}`) ?? null;
    if (!targetId && (!relocated.has(row.sourceDocumentId) || !relative)) continue;
    const resolved = resolveDocumentHref(row.href, holderOld);
    if (!resolved) continue;
    if (!targetId)
      targetId =
        (
          await resolver.resolve({
            projectId: scope.projectId,
            userId: scope.userId,
            target: { kind: "scheme", uri: spellDocumentHref(null, resolved.uri) },
          })
        )?.documentId ?? null;
    const targetOld = targetId ? await uri(targetId) : resolved.uri;
    const targetUri = targetId ? (relocated.get(targetId) ?? (await uri(targetId))) : resolved.uri;
    if (!targetUri) continue;
    const holderNew = relocated.get(row.sourceDocumentId) ?? holderOld;
    let spelled = respellDocumentHref(row.href, { holderUri: holderNew, targetUri });
    // Omission is retained only if the shorter spelling still reaches this identity.
    const shorter = resolveDocumentHref(spelled, holderNew);
    if (targetId && shorter && shorter.uri !== targetUri) {
      const targetProjectId = relocated.has(targetId)
        ? (destination.projectId ?? destination.workProjectId ?? scope.projectId)
        : row.targetProjectId;
      const files = (await candidates(targetProjectId, scope.userId, targetUri))
        .filter(
          (file) =>
            input.expectedTarget.state !== "occupied" ||
            file.id !== input.expectedTarget.token.nodeId,
        )
        .map((file) => ({ ...file, uri: relocated.get(file.id) ?? file.uri }));
      for (const [id, relocatedUri] of relocated) {
        if (relocatedUri.startsWith(destinationPrefix) && !files.some((file) => file.id === id))
          files.push({ id, uri: relocatedUri });
      }
      if (matchDocumentPath(files, shorter.uri, (file) => file.uri)?.id !== targetId)
        spelled = spellDocumentHref(relative ? holderNew : null, targetUri) + resolved.suffix;
    }
    if (spelled === row.href) continue;
    const inserted = await tx
      .insert(linkRedirects)
      .values({
        sourceDocumentId: row.sourceDocumentId,
        href: row.href,
        targetDocumentId: targetId,
        intendedUri: targetId ? null : targetUri,
        oldFilename: (targetOld ?? resolved.uri).slice(
          (targetOld ?? resolved.uri).lastIndexOf("/") + 1,
        ),
        moverUserId: input.mover?.userId ?? null,
        moverTurnId,
      })
      .onConflictDoNothing()
      .returning({ id: linkRedirects.sourceDocumentId });
    if (
      inserted.length &&
      scope.kind !== "manifest" &&
      !scope.documentDeletedAt &&
      !scope.archivedAt &&
      !scope.deletedAt
    ) {
      links += row.occurrences;
      holders.add(row.sourceDocumentId);
    }
  }
  return { links, documents: holders.size };
}
