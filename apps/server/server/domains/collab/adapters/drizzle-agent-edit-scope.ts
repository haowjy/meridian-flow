/** Centralizes the agent-edit partition key so live and draft state cannot mix. */

import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import { and, eq, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

export const LIVE_SCOPE = "live";

type AgentEditScopedTable = {
  documentId: AnyPgColumn<{ data: DocumentId }>;
  threadId: AnyPgColumn<{ data: ThreadId }>;
  scopeId: AnyPgColumn<{ data: string }>;
};

export type AgentEditScope = { documentId: string; threadId: string; scopeId: string };

export function scopedWhere(
  table: AgentEditScopedTable,
  scope: AgentEditScope,
  ...extraConditions: SQL[]
): SQL {
  return and(
    eq(table.documentId, scope.documentId as DocumentId),
    eq(table.threadId, scope.threadId as ThreadId),
    eq(table.scopeId, scope.scopeId),
    ...extraConditions,
  ) as SQL;
}

export function scopedConflictTarget(
  table: AgentEditScopedTable,
  ...extraColumns: AnyPgColumn[]
): [AnyPgColumn, AnyPgColumn, ...AnyPgColumn[]] {
  return [table.documentId, table.threadId, ...extraColumns, table.scopeId];
}

export function scopedValues(scope: AgentEditScope): {
  documentId: DocumentId;
  threadId: ThreadId;
  scopeId: string;
} {
  return {
    documentId: scope.documentId as DocumentId,
    threadId: scope.threadId as ThreadId,
    scopeId: scope.scopeId,
  };
}
