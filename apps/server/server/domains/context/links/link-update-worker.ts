/** Recover pending move redirects through the collab engine's atomic maintenance write. */
import { resolveDocumentHref, respellDocumentHref, spellDocumentHref } from "@meridian/contracts";
import type { DocumentId, TurnId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  contextSources,
  documents,
  linkRedirects,
  projects,
  works,
} from "@meridian/database/schema";
import { and, eq, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { DocumentLinkSubstitution, RewriteDocumentLinks } from "../../collab/index.js";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import { createDrizzleProjectWorkAuthorityResolver } from "../../projects/index.js";
import { createDrizzleContextCatalog } from "../adapters/context-catalog.js";
import { createDocumentLinkResolver } from "../document-link-resolution.js";
import { resolveDocumentUri } from "../document-uri-resolver.js";

export type LinkUpdateWorker = {
  sweep(): Promise<number>;
  kick(): void;
  stop(): Promise<void>;
};

export function createLinkUpdateWorker(input: {
  db: Database;
  rewriteDocumentLinks: RewriteDocumentLinks;
  eventSink: EventSink;
}): LinkUpdateWorker {
  let running: Promise<number> | undefined;
  let stopped = false;
  const authorities = createDrizzleProjectWorkAuthorityResolver(input.db);
  const due = () => or(isNull(linkRedirects.retryAfter), lte(linkRedirects.retryAfter, new Date()));
  const eligible = () =>
    and(
      isNull(documents.deletedAt),
      ne(documents.kind, "manifest"),
      isNull(contextSources.deletedAt),
      isNull(works.archivedAt),
      isNull(works.deletedAt),
    );
  function log(cause: unknown, documentId?: DocumentId) {
    emitEvent(input.eventSink, {
      level: "error",
      source: "context.link-updates",
      name: "rewrite.failed",
      payload: { documentId, ...unknownToEventPayload(cause) },
    });
  }

  async function pass(): Promise<number> {
    const holders = await input.db
      .selectDistinct({ id: linkRedirects.sourceDocumentId })
      .from(linkRedirects)
      .innerJoin(documents, eq(documents.id, linkRedirects.sourceDocumentId))
      .innerJoin(contextSources, eq(contextSources.id, documents.contextSourceId))
      .leftJoin(works, eq(works.id, contextSources.workId))
      .where(and(eligible(), due()))
      .orderBy(linkRedirects.sourceDocumentId);
    let count = 0;
    for (const holder of holders) {
      if (stopped) break;
      try {
        let consumed = false;
        await input.rewriteDocumentLinks({
          documentId: holder.id,
          async claim(cut) {
            const tx = currentDrizzleDb(input.db);
            // The engine already holds the mutation lock and holder row. Work lifecycle
            // is read, not locked: maintenance does not authorize on the mover's behalf.
            const [owner] = await tx
              .select({ userId: projects.userId })
              .from(documents)
              .innerJoin(contextSources, eq(contextSources.id, documents.contextSourceId))
              .leftJoin(works, eq(works.id, contextSources.workId))
              .innerJoin(projects, eq(projects.id, cut.holderProjectId))
              .where(and(eq(documents.id, holder.id), eligible()));
            if (!owner || !cut.holderUri) return null;
            const redirects = await tx
              .select()
              .from(linkRedirects)
              .where(and(eq(linkRedirects.sourceDocumentId, holder.id), due()))
              .orderBy(linkRedirects.href)
              .for("update");
            const resolver = createDocumentLinkResolver({
              catalog: createDrizzleContextCatalog(tx as Database),
              workAuthorityResolver: authorities,
            });
            const substitutions = new Map<string, DocumentLinkSubstitution>();
            const claimed: typeof redirects = [];
            for (const redirect of redirects) {
              const targetUri = redirect.targetDocumentId
                ? await resolveDocumentUri(tx, authorities, redirect.targetDocumentId)
                : redirect.intendedUri;
              // Unavailable targets remain pending until restore; never resolve the old address.
              if (!targetUri) continue;
              let href = respellDocumentHref(redirect.href, {
                holderUri: cut.holderUri,
                targetUri,
              });
              const shorter = resolveDocumentHref(href, cut.holderUri);
              if (redirect.targetDocumentId && shorter && shorter.uri !== targetUri) {
                const resolved = await resolver.resolve({
                  projectId: cut.holderProjectId,
                  userId: owner.userId,
                  target: { kind: "scheme", uri: shorter.uri },
                });
                if (resolved?.documentId !== redirect.targetDocumentId) {
                  const relative = !/^[a-z][a-z0-9+.-]*:\/\//i.test(redirect.href);
                  href =
                    spellDocumentHref(relative ? cut.holderUri : null, targetUri) + shorter.suffix;
                }
              }
              substitutions.set(redirect.href, {
                href,
                oldFilename: redirect.oldFilename,
                newFilename: targetUri.slice(targetUri.lastIndexOf("/") + 1),
              });
              claimed.push(redirect);
            }
            const newest = claimed.reduce<(typeof redirects)[number] | undefined>(
              (latest, row) => (!latest || row.createdAt > latest.createdAt ? row : latest),
              undefined,
            );
            if (!newest) return null;
            const mover = newest.moverTurnId
              ? { type: "agent" as const, actorTurnId: newest.moverTurnId as TurnId }
              : newest.moverUserId
                ? { type: "user" as const, actorUserId: newest.moverUserId }
                : null;
            if (!mover) throw new Error("Link redirect has no mover attribution");
            return {
              substitutions,
              mover,
              async consume() {
                await tx.delete(linkRedirects).where(
                  and(
                    eq(linkRedirects.sourceDocumentId, holder.id),
                    inArray(
                      linkRedirects.href,
                      claimed.map((row) => row.href),
                    ),
                  ),
                );
                consumed = true;
              },
            };
          },
        });
        if (consumed) count++;
      } catch (cause) {
        // The rewrite rolled back. Back off only pending rows, capped at five minutes.
        await input.db
          .update(linkRedirects)
          .set({
            attempts: sql`${linkRedirects.attempts} + 1`,
            retryAfter: sql`now() + least(300, power(2, least(${linkRedirects.attempts}, 9))) * interval '1 second'`,
          })
          .where(eq(linkRedirects.sourceDocumentId, holder.id));
        log(cause, holder.id);
      }
    }
    return count;
  }
  function sweep(): Promise<number> {
    if (stopped) return Promise.resolve(0);
    if (!running)
      running = pass().finally(() => {
        running = undefined;
      });
    return running;
  }
  return {
    sweep,
    kick() {
      void sweep().catch((cause) => log(cause));
    },
    async stop() {
      stopped = true;
      await running;
    },
  };
}
