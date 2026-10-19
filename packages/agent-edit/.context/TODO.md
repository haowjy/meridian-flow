# agent-edit TODO

Keep the editing protocol reusable across CRDT and tool implementations; do
not freeze a public abstraction until a second implementation exposes the seam.

## Find and character references

Decode character references in the find view so a query matches the text a
writer sees. The codec's edge-character encoding currently prevents some plain
text matches; the seam is `src/model/markdown-text-view.ts` and
`src/resolver/find.ts`.

## Response save

- `src/tool/response-committer.ts` runs two save protocols chosen by whether
  the host provides `stagedWrites`. Split them behind one save seam chosen per
  host at composition, with required host capabilities
  ([#938](https://github.com/haowjy/meridian-flow/issues/938)).

## Observation frontiers

- `src/tool/observation.ts` credits only `extent: full` blocks, so a write echo's
  context line shown whole (a paragraph shorter than the truncation) still lands
  in `unshown`. Decide when the region refusal lands ([decision](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/concurrent-safety/merge/ai-writes-plan-on-what-the-model-was-shown.md)):
  credit an untruncated context line as shown in full, or accept that the next
  write touching that paragraph is refused once with its current text.

## Deferred until earned

- Remove the remaining ProseMirror shape coupling from parsed-content types;
  the live-doc side already uses the neutral `AgentEditModel` seam.
- Freeze a public `DocumentPort`/`HistoryPort` only after a second
  implementation reveals stable contracts.
- Add a tool registry/capability gate only when a second tool surface makes the
  indirection testable.
- Revisit OSS packaging and surgical formatting from real merge observations,
  not from a speculative abstraction.
