/** Shared pending-placeholder classification and SQL predicate. */
import type { Turn, TurnRole } from "@meridian/contracts/threads";
import { type SQL, type SQLWrapper, sql } from "drizzle-orm";

export const PENDING_PLACEHOLDER_ROLES = ["compaction"] as const satisfies readonly TurnRole[];

export function isPlaceholderRole(role: TurnRole): boolean {
  return (PENDING_PLACEHOLDER_ROLES as readonly string[]).includes(role);
}

export function isPendingPlaceholder(turn: Pick<Turn, "role" | "status">): boolean {
  return turn.status === "pending" && isPlaceholderRole(turn.role);
}

export function interruptedPlaceholderError(turn: Turn): string {
  const metadata = turn.metadata;
  const trigger =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? metadata.trigger
      : undefined;
  if (turn.role === "compaction" && trigger === "manual")
    return "This manual compaction was interrupted.";
  if (turn.role === "compaction") return "This compaction was interrupted.";
  return `This ${turn.role.replaceAll("_", " ")} was interrupted.`;
}

export function pendingPlaceholderPredicate(columns: {
  role: SQLWrapper;
  status: SQLWrapper;
}): SQL {
  const roles = sql.join(
    PENDING_PLACEHOLDER_ROLES.map((role) => sql.raw(`'${role.replaceAll("'", "''")}'`)),
    sql`, `,
  );
  return sql`${columns.status} = 'pending' AND ${columns.role} IN (${roles})`;
}
