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

## Deferred until earned

- Remove the remaining ProseMirror shape coupling from parsed-content types;
  the live-doc side already uses the neutral `AgentEditModel` seam.
- Freeze a public `DocumentPort`/`HistoryPort` only after a second
  implementation reveals stable contracts.
- Add a tool registry/capability gate only when a second tool surface makes the
  indirection testable.
- Revisit OSS packaging and surgical formatting from real merge observations,
  not from a speculative abstraction.
