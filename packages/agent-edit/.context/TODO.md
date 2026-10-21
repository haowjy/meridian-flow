# agent-edit TODO

Keep the editing protocol reusable across CRDT and tool implementations; do
not freeze a public abstraction until a second implementation exposes the seam.

## Find and character references

Decode character references in the find view so a query matches the text a
writer sees. The codec's edge-character encoding currently prevents some plain
text matches; the seam is `src/model/markdown-text-view.ts` and
`src/resolver/find.ts`.

## One save sequencing before M3's landing check

A save still has two sequencings, and model inverses commit outside the port.
The reply save (and the pool's draft one-entry reply) prepares, persists inside
the pool's transaction and reports before commit (`response-committer.ts`); the
immediate save, `saveNow` in `tool/document-save.ts`, persists in a transaction
`appendBatch` owns and reports after durability. Undo, redo and revert journal
and deliver through collab's `drizzle-turn-inverse.ts`. Every save-time concern
lands once per path: the immediate path is where three review rounds' findings
lived, and a drafted agent write outside a reply (a one-entry reply) carries no
save-time "only if empty" precondition, which only `saveNow` passes. Unify
before M3's landing check, so it is written once: have `saveNow` run the reply
path's prepare, persist and report inside one transaction the host owns (the
pool's draft-only one-entry wrapper then becomes optional), and route inverses
through `prepareSave` when M2b moves revert to the write door.

## Deferred until earned

- Remove the remaining ProseMirror shape coupling from parsed-content types;
  the live-doc side already uses the neutral `AgentEditModel` seam.
- Freeze a public `DocumentPort`/`HistoryPort` only after a second
  implementation reveals stable contracts.
- Add a tool registry/capability gate only when a second tool surface makes the
  indirection testable.
- Revisit OSS packaging and surgical formatting from real merge observations,
  not from a speculative abstraction.

## Mixed inline/block raw review hunks

A separate alignment limitation surfaced while fixing #986's semantic-cleanup
paint bug: without an unchanged punctuation token between a trailing replacement
and a removed paragraph, `align.ts` can emit both as one raw replacement before
cleanup runs. Reproduce with base `["The crane watched the silent valley", "Lin
held a copper token beneath the old gate.", "Beyond the bridge, the river carried
fallen leaves."]` and draft `["The crane watched the roaring canyon", "Beyond
the bridge, the river carried fallen leaves.", "Lin held a silver compass beneath
the old gate."]`. The first raw hunk already includes P1's tail and all of Lin;
the source removal therefore still paints inline. Investigate preserving complete
block removals/additions independently of adjacent inline replacements in raw
alignment, without changing split/join composition or inventing painter-side
move heuristics. This is not introduced or resolved by the cleanup boundary fix.
