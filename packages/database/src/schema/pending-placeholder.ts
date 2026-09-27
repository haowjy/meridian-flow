/** SQL predicate shared by pending-placeholder queries and the partial index. */
import { PENDING_PLACEHOLDER_ROLES } from "@meridian/contracts/threads";
import { type SQL, type SQLWrapper, sql } from "drizzle-orm";

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
