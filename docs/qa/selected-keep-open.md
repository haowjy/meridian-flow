# Ordinary read arguments after compaction

- **Protects:** one read contract across tool calls and compaction, selected observation
  credit, whole-only duplicate elision, ranking and exact pricing. Extends
  [RP-4](runtime-probes.md#rp-4-proactive-autocompaction-and-byte-stable-continuation),
  not its lifecycle coverage.
- **Setup:** owned mock stack, private Agent and `compact` helper from RP-4.
  Keep raw captures outside the synced work directory, for example
  `E=/tmp/read-arguments-probe`. Seed Arrival, The Duel and Departure plus enough
  paragraphs for range and budget cases. Use the canonical URI from `doc put`.
  Read the document in a chat, then send another writer/reply pair.

  ```bash
  # The summary contains ordinary read arguments, not a new selector notation.
  jq -n --arg uri "$URI" '[{text:("## Objective\nContinue revising.\n\n## Documents to keep open\n"+({path:$uri,in:[3,4]}|tojson))}]' > "$E/summary.json"
  ./mf mock script @"$E/summary.json" --json
  compact > "$E/control.json"
  # Poll for THIS control's completed compaction, not an older completed turn.
  ./mf api GET "/api/threads/$T/snapshot" --json > "$E/snapshot.json"
  ./mf thread send "$T" 'Continue after the selected read.' \
    --mock '[{"text":"Selected continuation."}]' --json > "$E/continue.ndjson"
  ./mf thread context "$T" --all --view raw --json > "$E/requests.json"
  ```

## Argument parity

For each case, execute an ordinary `read` tool call and list the identical JSON
arguments in a fresh compaction cycle. Compare typed results, actual arguments
saved in `read.input`, the rewritten summary list and next model request.

- `{"path":"manuscript://Chapter#the-duel"}`: the heading and its section only.
- `{"path":"manuscript://Chapter","in":[7,10]}`: four blocks by position.
- String hash versus integer position: `"in":"2194"` versus `"in":2194` on
  a sufficiently large real document with that generated hash. Mixed range
  endpoints such as `"in":["2194",5]` retain their JSON types.
- `around` with a hash: the same neighbourhood as an ordinary read.
- `format: "outline"`: headings only, ordinary outline observation credit.
- `format: "edits"`, including `before` with a real write handle: the ordinary
  edits listing, accepted even when it carries no text frontier or shown links.
- `format: "full"`: same whole-read behaviour as omitting format.
- `version: "live"` and `version: "draft"`: create different live and Work-draft
  text, then compare both entry points. Include an explicit retained-draft read
  from a direct-mode thread; the existing draft-reader grant must still apply.
- Bare manuscript paths and ordinary `.md` normalization resolve to shown
  identities. A filename containing ` in: 7..10` remains a JSON path value, not
  selection syntax. Unknown documents never become arbitrary reads.

## No silent substitution

- A missing heading/hash, invalid position or denied version is omitted, never
  retried as a whole/default-version read. Include that document among the
  three recent identities to catch accidental reintroduction by recent ranking.
- A schema-invalid JSON object with an identifiable shown path (for example
  both `in` and `around`) also suppresses that identity's recent default.
  Malformed JSON with no identifiable path is ignored; independent recent
  selection may still re-show a document. Do not report that as a failed-read
  fallback.
- First listed identity wins, even if that read fails or exceeds the budget;
  later duplicates cannot broaden it. With no listed inputs, recent identities
  use default `{path}` reads, not arguments inherited from old snapshots.
- Old plain-URI/`in: 7..10` lines are not accepted as read arguments. There is no
  compatibility parser.

## Evidence and budget

- Only admitted whole reads with default version may elide full tail copies.
  Explicit `format: "full"` qualifies; fragments, `in`, `around`, outlines,
  edits and explicit versions do not. Actual version-specific observation
  evidence remains unchanged.
- Selected reads leave outside blocks unshown, even if unchanged full tail
  copies remain visible. After compaction, type distinctive outside text through
  the browser editor, then attempt an AI replacement there. Ordinary concurrent
  text/region-change rules must preserve the writer's change. Selection-edge
  writes may catch up an unshown neighbour before a subsequent attempt succeeds.
- The exact JSON input labels the budget wrapper, final list and projected read.
  Reserve the whole candidate list before admitting results. Check zero room,
  exact fit, one token too small, skipped-large then small, and an oversized
  selected success with no widening retry. Use a disposable production-module
  driver for exact arithmetic when live usage cannot target it reliably.
- Inspect fresh frontier rows and credited block IDs. Omitted, failed,
  oversized, cancelled and discarded preparations leave no committed evidence.
  A successful edits read with empty evidence must still persist its result.

## Lifecycle and browser

- Repeat the heading case under automatic compaction: optional Scratch response,
  summary with JSON read arguments, resumed reply. Manual and overflow compaction
  retain their existing bypass behaviour.
- Delay summary/preparation, enqueue late input, retry and Stop using the RP-4
  recipe or existing protocol harness. Only the winning completion's snapshots
  and evidence persist; cancellation is not converted into an omitted read.
- Independent browser: expand summary and selected/outline Read rows, inspect
  the returned text, continue, reload and inspect again. A read with no prose
  must not offer an empty expansion. Confirm writer text remains in the editor.
  Save screenshots and close owned browser sessions. CLI results are not UI
  evidence.

Record exact inputs, control and compaction IDs, expected/actual results and
coverage limits in the active work directory. This recipe is not a claim every
case passed. Remove temporary drivers and fixtures; stop only the owned stack.
