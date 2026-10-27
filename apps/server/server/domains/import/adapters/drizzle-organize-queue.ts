/** Postgres-backed organize claims with database-time leases and stale-owner fencing. */
import type { Database } from "@meridian/database";
import { imports, projects } from "@meridian/database/schema";
import { and, eq, sql } from "drizzle-orm";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import type { OrganizeClaim, OrganizeQueue } from "../ports/organize-queue.js";

const LEASE_SECONDS = 120;

type ClaimRow = {
  import_id: string;
  project_id: string;
  token: string;
  generation: number;
  lease_until: Date | string;
};

function claimOf(row: ClaimRow): OrganizeClaim {
  return {
    importId: row.import_id,
    projectId: row.project_id,
    token: row.token,
    generation: row.generation,
    leaseUntil: new Date(row.lease_until),
  };
}

export function createDrizzleOrganizeQueue(db: Database): OrganizeQueue {
  return {
    claim: () =>
      runInDrizzleTransaction(db, async () => {
        const [row] = await currentDrizzleDb(db).execute<ClaimRow>(sql`
          with candidate as (
            select i.id from imports i
            join projects p on p.id = i.project_id and p.deleted_at is null
            where i.state = 'organizing'
              and (i.lease_until is null or i.lease_until <= clock_timestamp())
            order by i.last_activity_at, i.id
            for update of i skip locked
            limit 1
          )
          update imports i set
            lease_token = gen_random_uuid(),
            lease_until = clock_timestamp() + ${LEASE_SECONDS} * interval '1 second'
          from candidate c where i.id = c.id
          returning i.id as import_id, i.project_id, i.lease_token as token,
            i.placement_generation as generation, i.lease_until
        `);
        return row ? claimOf(row) : null;
      }),
    heartbeat: (claim) =>
      runInDrizzleTransaction(db, async () => {
        const rows = await currentDrizzleDb(db)
          .update(imports)
          .set({ leaseUntil: sql`clock_timestamp() + ${LEASE_SECONDS} * interval '1 second'` })
          .where(
            and(
              eq(imports.id, claim.importId),
              eq(imports.state, "organizing"),
              eq(imports.leaseToken, claim.token),
              sql`${imports.leaseUntil} > clock_timestamp()`,
            ),
          )
          .returning({ id: imports.id });
        return rows.length === 1;
      }),
    release: (claim) =>
      runInDrizzleTransaction(db, async () => {
        await currentDrizzleDb(db)
          .update(imports)
          .set({ leaseToken: null, leaseUntil: null })
          .where(and(eq(imports.id, claim.importId), eq(imports.leaseToken, claim.token)));
      }),
  };
}
