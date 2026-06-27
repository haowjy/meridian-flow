/** Centralizes the agent-edit partition key so adding scope_id is one helper edit. */

import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import { and, eq, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

type AgentEditScopedTable = {
  documentId: AnyPgColumn<{ data: DocumentId }>;
  threadId: AnyPgColumn<{ data: ThreadId }>;
};

export type AgentEditScope = { documentId: string; threadId: string };

export function scopedWhere(
  table: AgentEditScopedTable,
  scope: AgentEditScope,
  ...extraConditions: SQL[]
): SQL {
  return and(
    eq(table.documentId, scope.documentId as DocumentId),
    eq(table.threadId, scope.threadId as ThreadId),
    ...extraConditions,
  ) as SQL;
}

export function scopedConflictTarget(
  table: AgentEditScopedTable,
  ...extraColumns: AnyPgColumn[]
): [AnyPgColumn, AnyPgColumn, ...AnyPgColumn[]] {
  return [table.documentId, table.threadId, ...extraColumns];
}

export function scopedValues(scope: AgentEditScope): {
  documentId: DocumentId;
  threadId: ThreadId;
} {
  return {
    documentId: scope.documentId as DocumentId,
    threadId: scope.threadId as ThreadId,
  };
}
