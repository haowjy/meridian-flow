# features/links — following an internal link

Shared link following for Editor and chat. A surface supplies resolution scope,
an `open` destination, and an outcome host; this module resolves and follows.
Link meaning and per-editor cache rules belong to
[`core/editor/links`](../../core/editor/links/AGENTS.md). A link is a standard
Markdown link to an address; `[[name]]` is text and never reaches here.

- An answer is keyed by the link's ref and href, never the holder's text, so two
  links sharing an href never share an answer, an edit re-asks nothing, and a
  gone ref is never followable. While scope is `pending` a click waits for the
  real scope.

- Scope is project, Work, optional lineage, holder base URI, and catalog
  revision. Editor scope comes from the holder's replica location; chat scope
  comes from the thread's Work. An unknown Work is `pending`, never a guessed
  authority, and route/remembered Work never supplies Editor scope.
- Register a resolver on every scope change. Registration is the sole cache
  invalidation; creates, moves, and deletes are catalog changes. Local answers
  paint immediately, while remote answers replace provisional ones.
- Surfaces call only the single follow procedure and injected `open`; they do
  not inspect resolution to decide navigation. Aborts stop before opening;
  newer current follows replace older ones, while new-tab follows are retained.
- One follower per surface. A follow that needs its own destination or its own
  answer to "nothing there" passes a `FollowPolicy` (`open`, `missing`) to that
  follower; it never builds a second one. Chat doors (tool-card names, receipt
  rows, passage doors) follow through chat's one follower this way, so doors
  and transcript links share one latest click, one dialog and the chat's
  lifetime ([link-following decision][link-following]).
- Reporter ownership is per follow. Dismiss and Retry operate through its
  verbs, not by branching on outcome state. Pending answers claim nothing.
- Missing creatable manuscript/kb/user documents offer Create at the exact
  canonical address and open locally at once. Uploads, Unfiled, and Scratch
  never offer link creation (a missing Scratch note reads "can't be found" in any
  Work state; Scratch notes come from the Work's Files tab or the AI). Failed checks say they failed, not that a link is
  unresolved. A missing target is a sentence, never a warning: linking ahead of
  writing is the job. Local answers never wait on the network, and a failed
  request fails only the questions it carried.

Read [`.context/CONTEXT.md`](.context/CONTEXT.md) for scope, answer, creation,
and document-index contracts.

[link-following]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/documents/identity/link-following.md
