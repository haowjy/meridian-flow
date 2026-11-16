import type { ContextSourceId, ProjectId, WorkId } from "@meridian/contracts";
import type { ContextUriScheme } from "@meridian/contracts/context-uri";
import type { ContextSource, ContextSourceOwner } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { contextSources, threads, works } from "@meridian/database/schema";
import { and, asc, eq, inArray, isNotNull, isNull, or, type SQL, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { ContextSources } from "../ports/context-sources.js";
import { sourceAuthority } from "./context-file-entry.js";

const PROJECT_SLUGS = ["manuscript", "kb", "unfiled", "agents"];

/**
 * The sources a project's owner reads. A Work's are listed until the Work is purged: an archived
 * or deleted Work's notes are read-only, not gone, and a purge takes the source rows with it. A
 * lineage's and a chat's are listed until the source itself ends.
 */
export function createDrizzleContextSources(db: Database): ContextSources {
  async function read(where: SQL | undefined): Promise<ContextSource[]> {
    const rows = await currentDrizzleDb(db)
      .select({
        id: contextSources.id,
        name: contextSources.name,
        slug: contextSources.slug,
        workId: contextSources.workId,
        workHandle: works.handle,
        rootThreadId: contextSources.rootThreadId,
        chatThreadId: contextSources.chatThreadId,
        account: sql<boolean>`${contextSources.scope} = 'account'`,
        ownerThreadRef: threads.ref,
      })
      .from(contextSources)
      .leftJoin(works, eq(contextSources.workId, works.id))
      .leftJoin(
        threads,
        eq(
          threads.id,
          sql`coalesce(${contextSources.rootThreadId}, ${contextSources.chatThreadId})`,
        ),
      )
      .where(and(isNull(contextSources.deletedAt), where))
      .orderBy(asc(contextSources.sortOrder), asc(contextSources.id));
    return rows.map((row): ContextSource => {
      const scheme = row.slug as ContextUriScheme;
      const owner: ContextSourceOwner = row.account
        ? { kind: "account" }
        : row.chatThreadId
          ? { kind: "chat", chatId: row.chatThreadId }
          : row.rootThreadId
            ? { kind: "lineage", rootThreadId: row.rootThreadId }
            : row.workId
              ? { kind: "work", workId: row.workId as WorkId }
              : { kind: "project" };
      return {
        id: row.id as ContextSourceId,
        scheme,
        name: row.name,
        owner,
        authority: sourceAuthority(
          scheme,
          row.workId,
          row.workHandle,
          row.ownerThreadRef,
          row.chatThreadId !== null,
        ),
      };
    });
  }

  const ofProject = (projectId: ProjectId) =>
    and(
      eq(contextSources.projectId, projectId),
      inArray(contextSources.slug, PROJECT_SLUGS),
      isNull(contextSources.workId),
      isNull(contextSources.rootThreadId),
      isNull(contextSources.chatThreadId),
    );
  const ofWorks = (projectId: ProjectId) => eq(works.projectId, projectId);

  return {
    inProject(projectId) {
      return read(
        sql`(${ofProject(projectId)} or ${ofWorks(projectId)}
          or (${eq(contextSources.projectId, projectId)} and (${isNotNull(contextSources.rootThreadId)} or ${isNotNull(contextSources.chatThreadId)})))`,
      );
    },
    async endedIn(projectId) {
      const rows = await currentDrizzleDb(db)
        .select({ id: contextSources.id })
        .from(contextSources)
        .leftJoin(works, eq(contextSources.workId, works.id))
        .where(
          and(
            or(eq(contextSources.projectId, projectId), eq(works.projectId, projectId)),
            isNotNull(contextSources.deletedAt),
          ),
        );
      return rows.map((row) => row.id as ContextSourceId);
    },
    ofUser(userId) {
      return read(and(eq(contextSources.scope, "account"), eq(contextSources.userId, userId)));
    },
    ownedBy(projectId, owner) {
      switch (owner.kind) {
        case "project":
          return read(ofProject(projectId));
        case "work":
          return read(and(eq(contextSources.workId, owner.workId), ofWorks(projectId)));
        case "lineage":
          return read(
            and(
              eq(contextSources.rootThreadId, owner.rootThreadId),
              eq(contextSources.projectId, projectId),
            ),
          );
        case "chat":
          return read(
            and(
              eq(contextSources.chatThreadId, owner.chatId),
              eq(contextSources.projectId, projectId),
            ),
          );
      }
    },
  };
}
