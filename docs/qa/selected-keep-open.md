# Selected keep-open reads after compaction

- **Protects:** selected re-show scope, fresh frontier credit, whole-only tail
  duplicate elision, fallback, ranking and exact pricing. This extends RP-4; it does not replace its lifecycle checks.
- **Setup:** use the owned mock stack, Agent and `compact` helper from
  [RP-4](runtime-probes.md#rp-4-proactive-autocompaction-and-byte-stable-continuation). Keep
  raw captures outside synced work artifacts (for example `E=/tmp/keep-open-probe`).
  Seed at least three heading sections and 100 numbered paragraphs. Use the
  canonical `uri` returned by `doc put`, not its display filename (`.md` is
  normally omitted). Ordinary tool arguments use `path`, not `file`.

  ```bash
  python3 - <<'PY' > "$E/chapter.md"
  print('# Arrival\n\nOUTSIDE arrival.\n\n# The Duel\n\nDUEL selected body.\n\n# Departure\n\nOUTSIDE departure.')
  print('\n\n'.join(f'Numbered paragraph {i} distinctive.' for i in range(1, 101)))
  PY
  ./mf doc put manuscript://SelectorProbe.md --text @"$E/chapter.md" --json > "$E/doc.json"
  URI=$(jq -r .uri "$E/doc.json")
  ./mf thread send "$T" 'Read the whole chapter.' --mock \
    "[{\"toolCalls\":[{\"name\":\"read\",\"args\":{\"path\":\"$URI\"}}]},{\"text\":\"Read complete.\"}]" --json > "$E/read.ndjson"
  ./mf thread send "$T" 'Keep the full copy in the tail.' --ref "$URI" \
    --mock '[{"text":"Tail complete."}]' --json > "$E/tail.ndjson"
  # Manual compaction has no notes step and need not reserve an assistant continuation.
  jq -n --arg uri "$URI" '[{text:("## Objective\nContinue revising.\n\n## Documents to keep open\n"+$uri+"#the-duel")}]' > "$E/summary.json"
  ./mf mock script @"$E/summary.json" --json
  compact > "$E/compact.json"
  # Poll snapshot until THIS control's C completes; do not accept an older complete C.
  ./mf api GET "/api/threads/$T/snapshot" --json > "$E/snapshot.json"
  ./mf thread send "$T" 'Continue after selected compaction.' \
    --mock '[{"text":"Selected continuation."}]' --json > "$E/continue.ndjson"
  ./mf thread context "$T" --all --view raw --json > "$E/requests.json"
  eval "$(pnpm exec tsx tools/dev/print-worktree-env.ts)"
  tools/qa/probes/observation-frontiers.sh "$T" > "$E/frontiers.txt"
  ```

- **Heading/full tail/M2:** C contains one reference `read.selector.fragment`
  `the-duel`, only the heading and its body. The actual successor request names
  that selector and keeps the unchanged full tail read; `metadata.elisions`
  must not mark that identity `reshown`. The C reference frontier has outside
  block IDs in `unshown`; only its ID is credited for this document, never the
  retained tail. A fresh null frontier initially has no `changed` listing.
  After C, insert distinctive writer text in Arrival through the browser editor
  (a writer Yjs session, not another AI tool). Script a `write replace` outside
  the selection. Inspect the actual tool result/concurrent listing, receipt and
  final document: the writer insertion survives. Also target the edge of the
  selected section: the region includes an unshown neighbour, so the first
  attempt gets `region_changed` with current region text. Retry the same edit
  after that response: it lands. This is the owner's region rule, not a selector
  defect; do not widen credit or bypass it for compaction.
  Repeat with enough large changed outside blocks that the target falls beyond
  the concurrent-listing byte cap, exercising unseen-projection planning (M2).
- **Selectors:** on fresh compactable cycles repeat `in: 4`, `in: 40..95`,
  `in: "<blockhash>"`, `in: "<startHash>".."<endHash>"`, `#<blockhash>` and
  `#<headingHash>`, using hashes from the ordinary read. Compare exact bodies
  and block IDs; the numeric range persists `[40,95]`, not a string. Reload,
  send again and compare persisted-selector projection to its priced heading.
- **Fallback/rank:** missing heading/hash and `in: 9000` each retry whole once.
  A fitting fallback persists no selector and permits whole duplicate elision;
  failed selections leave no frontier. List two sections for one document, then
  whole/selected in both orders: exactly one C read, first-ranked wins. Repeat
  compaction with no list: recent identities are whole, not inherited selectors.
- **Exact names:** seed names with parentheses and punctuation; list them wrapped
  in backticks/angles or with list markers. Use the matcher seam for literal
  ` in: 40..95` or fragment-looking names the real filename grammar rejects.
  Exact shown filenames win across decoration layers before selector parsing.
  Unknown near-prefixes/extensions and malformed/mixed selectors stay unknown,
  never arbitrary document resolution. A literal fragment-looking filename can
  be checked at the matcher seam if the real filename grammar disallows it.
- **Budget:** use a second Agent with a lower `autocompact` trigger and a large
  document containing one tiny heading section. Calibrate with the same
  `estimateModelPartTokens` and tokenizer: room is
  `max(0,floor((trigger-base)/2)-1000)`, with all requested selector-bearing
  keep-open list lines reserved first. Show selected success where whole fails;
  A missing selector with oversized whole fallback is omitted from the final
  list, records no frontier, and still allows a later small candidate. Oversized selected successes must not expand to whole. Check zero
  room, skipped-large then small, and more than three listed identities (no
  count cap). Exact equality fits, one token less omits; isolate those two
  arithmetic boundaries in a disposable seam driver if live estimation cannot
  target them cheaply. Compare the full rendered envelope, selected heading and
  final `tokensAfter`, never a truncated body.
- **Automatic/draft:** repeat the heading case under automatic compaction when
  the stack supports request-derived mock usage. Queue the appropriate optional
  Scratch responses only if that separate feature is installed, then summary
  and continuation. The selector feature does not require a Scratch step.
  Run draft-mode and auto-apply threads: C uses the same effective version as an
  ordinary read. Capture both a selected C and its next compaction after reload;
  C10 resets credit each time. Check ordinary mentions and whole keep-open too.
- **Retry/Stop:** delay the summary, enqueue late writer input and verify only
  winning preparation blocks/frontiers persist. Stop while summary/preparation
  is outstanding: cancellation must not become whole fallback or commit late
  evidence. Use the existing compaction-protocol transaction harness for a
  precise discarded-read window that the mock cannot hold reliably.
- **Browser (separate prober):** inspect selected continuation, the compaction divider
  and concurrent-write receipt, confirm writer text in the editor, reload and
  take screenshots on these same owned routes. CLI captures do not certify UI.
- **Evidence:** exact commands and expected/actual results, control UUID, raw C
  blocks and elisions, request captures, frontier rows, credited IDs, writer
  mutation and final document. Report unreachable windows explicitly. Stop only
  this stack with `pnpm dev --stop`; retain fixture IDs for the browser prober.
This recipe is not a claim that every case passed. Record evidence and any
unreachable cases in the active work directory.

Digit-only hashes: use a real generated hash such as `2194` (Y.Doc client id 2).
`in: "2194"` must read that hash, while `in: 2194` means position 2194.
Check `in: "2194"..5` and persisted/replayed labels preserve endpoint types.
