# @meridian/loro-prosemirror

Our fork of the ProseMirror ↔ Loro binding. What came from upstream and what is ours:
[UPSTREAM.md](UPSTREAM.md). Design: `loro-build/design.md` §1 and §6 in the docs repository.

- Between transactions the editor's document is what the `LoroDoc` holds; every local write is
  computed against that. Keep it true.
- Import a peer's update with `importRemoteUpdate`, never `doc.import`: it holds the update while
  an editor on the document is in an IME composition. An import during a composition that
  changes the composing block doubles or drops the composed text (gate 1 evidence,
  `loro-build/gate/1-binding-ime/` in the docs repository).
- Every peer that writes marks (each tab and the server) calls `configLoroTextStyle(doc, schema)`
  before its first mark: Loro keeps the style config per peer, not in the document.
