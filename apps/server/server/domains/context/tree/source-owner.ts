/**
 * Who owns a source, and so its documents and its nodes' list: a project (its own, or its Work's)
 * or an account (the home folder). The one place a source's owner is worked out; every reader
 * takes it from here instead of joining a project through the source.
 */
import { contextSources, works } from "@meridian/database/schema";
import { type SQL, sql } from "drizzle-orm";
import type { TreeList } from "../ports/tree-list-store.js";

/** The owning project of the source aliased `source` (its Work aliased `work`); null for an account's. */
export function ownerProjectIdSql(source: string, work: string): SQL {
  return sql`COALESCE(${sql.identifier(source)}.project_id, ${sql.identifier(work)}.project_id)`;
}

/** `ownerProjectIdSql` over `context_sources` and a left-joined `works`, for the query builder. */
export const sourceOwnerProjectId = sql<
  string | null
>`coalesce(${contextSources.projectId}, ${works.projectId})`;

/** A row's owner from its owning project and account columns; exactly one is set. */
export function ownerFrom(row: { projectId: string | null; userId: string | null }): TreeList {
  if (row.projectId) return { kind: "project", projectId: row.projectId };
  if (row.userId) return { kind: "account", userId: row.userId };
  throw new Error("A source has no owner");
}

/** The owner as the pair of owner columns a row stores, one of them null. */
export function ownerColumns(owner: TreeList): { projectId: string | null; userId: string | null } {
  return owner.kind === "project"
    ? { projectId: owner.projectId, userId: null }
    : { projectId: null, userId: owner.userId };
}

export function sameOwner(a: TreeList, b: TreeList): boolean {
  return a.kind === "project"
    ? b.kind === "project" && a.projectId === b.projectId
    : b.kind === "account" && a.userId === b.userId;
}

/**
 * Whether a row belongs to the request: a project's to the project the request is in, an
 * account's to the account making it. The one rule wherever a file is matched to a request.
 */
export function ownedByRequest(
  owner: TreeList,
  request: { projectId: string | null; accountId: string | null },
): boolean {
  return owner.kind === "project"
    ? owner.projectId === request.projectId
    : owner.userId === request.accountId;
}

/** `ownedByRequest` over a row's owner columns and the request's, for a query. */
export function ownedByRequestSql(
  columns: { projectId: SQL; userId: SQL },
  request: { projectId: SQL; accountId: SQL },
): SQL {
  return sql`(${columns.projectId} = ${request.projectId} OR ${columns.userId} = ${request.accountId})`;
}
