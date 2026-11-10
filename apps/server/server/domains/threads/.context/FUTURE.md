# FUTURE — deferred directions for threads (not commitments)

## Indexed chat title search ([#594](https://github.com/haowjy/meridian-flow/issues/594))

Chat feed search is an unindexed `title ILIKE '%q%'` (`chat-feed-repository.ts`),
fine to about 10k chats per project. Past that, add a partial `pg_trgm` GIN index on
`threads.title`. Trigrams can't come from a 1–2 character pattern, and those are
normal in Chinese, so bound short queries to the recent window or accept a bounded
scan. Benchmark English and CJK at 10k, 100k and 1M rows before choosing.

## Message-content search ([#595](https://github.com/haowjy/meridian-flow/issues/595))

Needs its own server endpoint and incremental index over turn text; it is not an
extension of title search. Postgres built-in FTS doesn't segment Chinese: choose
between `pg_trgm`, a segmentation extension or a dedicated engine from a real English
and Chinese relevance set.

## More prompt epoch causes

Other `beginPromptEpoch` causes are deferred: a fork with a fresh bake, a refresh when
the provider cache is already known cold, and a forced refresh. Each would be a named
boundary turn ([frozen prefix][kb-frozen-prefix]).

## Journal writes

- **One-statement batch append.** `adapters/drizzle/event-writer.ts` `appendEvents` runs BEGIN, `UPDATE threads.next_seq`, a multi-row INSERT, `pg_notify` and COMMIT: about five round trips per batch. A single CTE (update, insert, notify) would make it one. Trigger: a profile of many concurrent paced streams showing journal write load or pool waits.

[kb-frozen-prefix]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/architecture/agents/request-prefix.md
