// Save latency against snapshot size: the debounced save's transaction (advisory lock, read frontiers, upsert
// bytea) at 0.2, 1, 2 and 5 MB (5 MB is design §4's compaction threshold). node gate4/save-sizes.mjs <adminUrl>

import { randomBytes } from "node:crypto";
import postgres from "postgres";

const ADMIN = process.argv[2] ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";
const DB = `gate_${process.env.MERIDIAN_SPAWN_ID ?? "p18917"}_sizes`;
const admin = postgres(ADMIN, { max: 1, onnotice: () => {} });
await admin.unsafe(`drop database if exists ${DB}`);
await admin.unsafe(`create database ${DB}`);
const sql = postgres(ADMIN.replace(/\/[^/]*$/, `/${DB}`), { max: 2, onnotice: () => {} });
await sql`create table document_snapshots (room_key text primary key, snapshot bytea not null, frontiers jsonb not null, saved_at timestamptz not null)`;
const frontiers = [{ peer: "123456789012345", counter: 99999 }];
for (const mb of [0.2, 1, 2, 5]) {
  const ms = [];
  for (let i = 0; i < 30; i++) {
    const bytes = randomBytes(Math.round(mb * 1048576)); // incompressible, as Loro snapshots largely are
    const t = performance.now();
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${"live:x"}, 0))`;
      await tx`select frontiers from document_snapshots where room_key = ${"live:x"}`;
      await tx`insert into document_snapshots values (${"live:x"}, ${bytes}, ${tx.json(frontiers)}, now()) on conflict (room_key) do update set snapshot = excluded.snapshot, frontiers = excluded.frontiers, saved_at = excluded.saved_at`;
    });
    ms.push(performance.now() - t);
  }
  ms.sort((a, b) => a - b);
  console.log(
    `${mb} MB: p50 ${ms[15].toFixed(1)} ms, p90 ${ms[27].toFixed(1)} ms, max ${ms[29].toFixed(1)} ms (30 saves)`,
  );
}
await sql.end();
await admin.unsafe(`drop database ${DB}`);
await admin.end();
