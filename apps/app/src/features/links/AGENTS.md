# features/links — following an internal link

A surface supplies resolution scope, an `open` destination and an outcome host; this
module resolves and follows. Link meaning and per-editor cache rules belong to
[`core/editor/links`](../../core/editor/links/AGENTS.md). The outcomes are in the
[link-following rules][link-following].

- An answer is keyed by the link's ref and href, never the holder's text, so two links
  sharing an href don't share an answer.
- An unknown Work is `pending`, never a guessed authority, and route or remembered Work
  never supplies Editor scope.
- Registering a resolver is the sole cache invalidation, and a catalog change counts as a
  scope change. Add no second invalidation path.
- Surfaces call only the follow procedure and injected `open`; they don't inspect
  resolution to decide navigation.
- One follower per surface. A follow that needs its own destination or its own answer to
  "nothing there" passes a `FollowPolicy` to that follower. Chat doors do this, so doors
  and transcript links share one latest click.
- A folder answer opens nothing here: the surface draws the folder menu instead.

Scope, follow, creation and document-index contracts:
[`.context/CONTEXT.md`](.context/CONTEXT.md).

[link-following]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/documents/links.md#following-a-link-is-one-procedure
