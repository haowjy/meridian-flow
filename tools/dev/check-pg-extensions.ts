#!/usr/bin/env tsx
/**
 * Proves the Postgres behind DATABASE_URL can serve writer search: pg_bigm is preloaded,
 * pg_bigm, btree_gin and pg_trgm install, and a 1-character Han LIKE is narrowed by a
 * (uuid, text gin_bigm_ops) index. Runs in a transaction that rolls back, so it leaves
 * nothing behind. Used by `pnpm db:check-extensions` and the CI db-tests job.
 */
import postgres from "postgres";
import { formatPgError } from "./lib/dev-db";
import { applyDevEnvToProcess } from "./lib/dev-env";

class Rollback extends Error {}

/** Actual Rows of the first Bitmap Index Scan node in an `explain (format json)` plan. */
function findBitmapIndexScanRows(node: unknown): number | undefined {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findBitmapIndexScanRows(item);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (node === null || typeof node !== "object") return undefined;
  const record = node as Record<string, unknown>;
  if (record["Node Type"] === "Bitmap Index Scan") return Number(record["Actual Rows"]);
  for (const value of Object.values(record)) {
    const found = findBitmapIndexScanRows(value);
    if (found !== undefined) return found;
  }
  return undefined;
}

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
        await tx.unsafe(
          "insert into search_probe select gen_random_uuid(), '他说' || i || '山' from generate_series(1, 200) i",
        );
        await tx.unsafe("insert into search_probe values (gen_random_uuid(), '他说剑来')");
        await tx.unsafe("analyze search_probe");
        await tx.unsafe("set local enable_seqscan = off");
        // The index must narrow the search: the bitmap scan returns the one matching row, not all 201.
        const [explained] = await tx.unsafe(
          "explain (analyze, format json) select 1 from search_probe where body like '%剑%'",
        );
        const bitmapRows = findBitmapIndexScanRows(explained?.["QUERY PLAN"]);
        if (bitmapRows !== 1) {
          throw new Error(
            `1-character Han LIKE: expected a Bitmap Index Scan returning 1 row, got ${bitmapRows}:\n${JSON.stringify(explained?.["QUERY PLAN"])}`,
          );
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
