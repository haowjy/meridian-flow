# FUTURE — deferred directions for threads (not commitments)

## Indexed chat title search ([#594](https://github.com/haowjy/meridian-flow/issues/594))

Chat feed search is an unindexed `title ILIKE '%q%'` within the project,
applied with Favorites before keyset pagination (`chat-feed-repository.ts`).
It scans every primary chat per settled keystroke: fine to about 10k chats per
project. Past that, add a partial `pg_trgm` GIN index on `threads.title`.
Trigrams cannot come from a 1–2 character pattern, and those are normal in
Chinese, so bound short queries to the recent window or accept a bounded scan.
Benchmark English and CJK at 10k, 100k, and 1M rows before choosing.

## Message-content search ([#595](https://github.com/haowjy/meridian-flow/issues/595))

Finding the chat where something was discussed needs its own server endpoint
and incremental index over turn text. It returns chat, excerpt, and deep link.
It is not an extension of title search. Postgres built-in FTS does not segment
Chinese: choose between `pg_trgm`, a segmentation extension, or a dedicated
engine from a real English and Chinese relevance set.
