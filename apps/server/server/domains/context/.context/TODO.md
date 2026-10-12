# domains/context — deferred work

Delete an entry when it ships.

- **Planning 2,000 notes takes about 65 s, mostly bulk tree creation.**
  `adapters/drizzle-context-bulk-creation.ts` creates an import's folders and
  seeded placeholders in 200-row chunks, one catalog refresh each. Follow-up:
  profile one chunk with
  `pnpm probe:db apps/server/scripts/probe-import-performance.ts --out <file>`
  (it records `chunkCreateMs`), find which per-document step dominates, and make
  it set-based while keeping one refresh per chunk.
