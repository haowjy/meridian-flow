# Round trip through the shape and the binding

`round-trip.probe.ts` checks `@meridian/document-model` and this binding on the real schema
(`buildDocumentSchema`), with no stack. Run it when the codec, the normalizer, the writes,
`applyOps`, the envelope, the sync plugin or the in-memory rooms change:

```sh
pnpm --filter @meridian/loro-prosemirror exec tsx .context/qa/round-trip.probe.ts
```

It prints `ok: <n> checks` or the first failed check with the two documents, and exits non-zero.

What it covers:

- Fixtures parsed from Markdown and MDX through `@meridian/markup` (prose with every mark, hard
  breaks and Unicode, nested lists and quotes, a table with alignment, an empty cell and an image,
  a code block, inline images, a `jsx_container` holding a `jsx_leaf`) plus overlapping comments
  and a comment on an image. Each goes doc → shape → ProseMirror and must be `eq` to the fixture;
  a second write must be a no-op; the envelope, a snapshot load and real `loro-protocol`
  `DocUpdate` and `JoinRequest` frames must carry the bytes unchanged; a draft fork must show its
  edit, leave Live and its base maps alone, and drop every override once written back to Live's
  content.
- Merged states: a concurrent move and retype, an emptied cell's derived empty paragraph, `code`
  shown alone, U+FFFC without its style, a comment with no body hidden and shown once the body
  arrives, with write-backs that write nothing.
- `applyOps`: a splice with an inline node, a format, an attribute set, an insert, a delete, the
  commit message, and a refused out-of-range splice.
- The sync plugin with a stand-in view: typing on the fast path (one op, no style op inside bold),
  a split, a remote batch with the caret kept, a batch held during composition and released on
  `compositionend`, and a Draft editor forking a block and showing a forwarded Live batch.
- The in-memory `DocumentRooms`: seed, write, subscribe, a commit imported only after its
  transaction, a fork room forwarded on load, and a reload from the stored rows.

Not covered: a real browser and IME (phase 1c reruns gate 1's matrix on this binding), the
Postgres adapter, and the block-change model (the press, its Undo, Discard and `Restore before`:
[block-changes-fuzz.md](block-changes-fuzz.md)).
