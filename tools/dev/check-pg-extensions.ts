#!/usr/bin/env tsx
/**
 * Proves the Postgres behind DATABASE_URL can serve writer search: pg_bigm is preloaded,
 * pg_bigm, btree_gin and pg_trgm install, and a 1-character Han LIKE can use a
 * (uuid, text gin_bigm_ops) index. Runs in a transaction that rolls back, so it leaves
 * nothing behind. Used by `pnpm db:check-extensions` and the CI db-tests job.
 */
import postgres from "postgres";
import { formatPgError } from "./lib/dev-db";
import { applyDevEnvToProcess } from "./lib/dev-env";

class Rollback extends Error {}

async function main(): Promise<void> {
  applyDevEnvToProcess();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const [row] = await sql<{ preload: string }[]>`
      select current_setting('shared_preload_libraries') as preload`;
    const preload = row?.preload ?? "";
    if (!preload.split(",").some((lib) => lib.trim() === "pg_bigm")) {
      throw new Error(`shared_preload_libraries is "${preload}", expected it to include pg_bigm`);
    }
    await sql
      .begin(async (tx) => {
        await tx.unsafe("create extension if not exists pg_bigm");
        await tx.unsafe("create extension if not exists btree_gin");
        await tx.unsafe("create extension if not exists pg_trgm");
        await tx.unsafe("create temp table search_probe (owner uuid, body text) on commit drop");
        await tx.unsafe(
          "create index search_probe_idx on search_probe using gin (owner, body gin_bigm_ops)",
        );
        await tx.unsafe("insert into search_probe values (gen_random_uuid(), '他说剑来')");
        await tx.unsafe("set local enable_seqscan = off");
        const plan = await tx.unsafe("explain select 1 from search_probe where body like '%剑%'");
        const text = plan.map((row) => String(row["QUERY PLAN"])).join("\n");
        if (!text.includes("search_probe_idx")) {
          throw new Error(`1-character Han LIKE did not use the gin_bigm_ops index:\n${text}`);
        }
        const hits = await tx.unsafe("select 1 from search_probe where body like '%剑%'");
        if (hits.length !== 1) throw new Error(`expected 1 Han LIKE hit, got ${hits.length}`);
        throw new Rollback();
      })
      .catch((err: unknown) => {
        if (!(err instanceof Rollback)) throw err;
      });
    console.log("▸ pg_bigm, btree_gin and pg_trgm install and serve a 1-character Han LIKE");
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => {
  console.error("✗ check-pg-extensions failed:", formatPgError(err));
  process.exit(1);
});
