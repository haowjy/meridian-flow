# Upstream

Fork of [`loro-dev/loro-prosemirror`](https://github.com/loro-dev/loro-prosemirror) at `v0.4.4`,
commit `0e036a9bedb432ea7ae238c82d379e1a2fca11d6` (MIT, `LICENSE` kept). Source only: the tests,
Storybook and build setup stay upstream. Formatted with this repository's Biome.

## Folded from upstream

| Upstream | What it fixes | How it came in |
|---|---|---|
| PR #85 (open) | Remote update restored the selection from a timer: caret at the document's end until it fired, and an old timer could overwrite a newer selection | Taken as is (the base of #86) |
| PR #86 (open) | Every keystroke reconciled the whole tree and materialised the paragraph's delta; cost grew with mark history | Taken as is: `tryUpdateLoroTextFromTransaction` (one closed text `ReplaceStep` written to the existing `LoroText`) and the per-pass delta cache |
| Issue #87 | Per-keystroke JS–WASM calls grow with the paragraph count | Covered by #86's fast path for typing; the identity-skip idea in the issue is not taken (measured unnecessary at 10k words) |
| Issue #77 | A `docChanged` transaction before `init` writes the editor's placeholder over the Loro content; the plugin's own transactions were written back on every import | The issue's patch: `initialized` flag, and `appendTransaction` skips transactions tagged with the plugin's meta. Plus the follow-up the thread asks for: `init` seeds an empty Loro document from an editor that already holds content instead of deleting it |
| Issue #88 | Marks on inline non-text nodes (a comment on a hard break) dropped | No PR exists. Ours: a `marks` map on the node's `LoroMap`, keyed like text styles, read and written beside `attributes` |
| PR #84 (open) | `updateLoroMapAttributes` emitted a delete op for every null attribute already absent | Taken as is |
| PR #76 (open) | The `sys:init` commit passed milliseconds as Loro's timestamp (seconds) | Taken as is |

## Ours

- **Block id pairing** (`block-id.ts`, `updateLoroMapChildren`): ported from `main`'s patched
  y-tiptap (`pairByBlockId`, `movedIds`). Under the document or a block that keeps its id,
  children pair by the block `id` attribute; a container is never reused for another id, and a
  dragged block is the one re-created.
- **Comment keys** (`text-style.ts`): a `comment` mark is stored as style key `comment_<id>` with
  value `true`, so two comments on the same words are two keys. Other marks keep one key per
  mark name.
- **Text style registration** (`configLoroTextStyle`): every schema mark but `comment`, `expand`
  from `inclusive` (`after` unless `inclusive: false`); the default style is `none`, which covers
  the `comment_<id>` keys.
- **Composition guard** (`composition-hold.ts`): `importRemoteUpdate(doc, bytes)` holds a remote
  update while an editor on `doc` is composing and imports the held updates as one batch after
  the composition ends.
- **Selection across a remote update** (`rememberSelection`): the selection is kept as Loro
  cursors taken while the editor and Loro agree, so a peer's insert earlier in the caret's block
  doesn't move the caret; a collapsed caret holds the character before it.
- **Commit origin per transaction** (`setCommitOrigin`): a transaction's Loro write commits
  under the origin it carries (default `loroSyncPlugin`).
