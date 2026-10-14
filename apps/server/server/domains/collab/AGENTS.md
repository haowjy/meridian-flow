# domains/collab — server-side branch collaboration

This domain composes `@meridian/agent-edit` with Meridian persistence and
Hocuspocus transport. It owns durable live and branch Yjs infrastructure, not
editor UI or transport-shell policy.

## Mental model

- Live documents, per-thread peers, and per-Work draft text branches are real
  Y.Docs. Journals are durable and runtime state is reconstructible.
- A text branch holds two fragments: `prosemirror` (the draft text the writer
  and the AI edit) and the server-owned `review_base` (live's text as of the
  branch's `base_revision`). The review is the browser's projection of one
  against the other. The server stores no review operations, classes or
  tokens, and a draft change has no server identity beyond what the projection
  recomputes (`changeId`).
- A text branch shares no Yjs lineage with live. It is seeded as fresh items
  written by the reserved server client (`DRAFT_SERVER_CLIENT_ID`), and it
  catches up to live by a three-way content rebase (base, live, draft) on live's
  certified cut, not by a Yjs pull. Only thread peers still pull their Work
  draft's Yjs state.
- A Work draft is shared by every thread editing the same document in that Work.
  Apply is a content merge: the change the writer saw merges into live's current
  text, and live text it replaced comes back as `overrode`. No draft bytes reach
  live and no live bytes enter a text branch. Apply never closes the draft.
- Discard is a writer edit. A change, "Discard draft", the strip and a Work row
  set draft text back to the base inside the room, undone by Ctrl+Z or the row's
  Undo, with no command. Only two kernel commands close anything: item Discard
  (a created, binary or live-deleted item) and Discard all. The kernel closes
  branches and never resets text from live.
- A writer or AI edit that leaves the draft equal to its base leaves the item
  unlisted but addressable; its room, history and next proposal stay.
- Independent deleting edits from separate chats stay separate: draft agent
  writes stay separate per logical write, atomically published per reply.
- Each live document has a durable authority head whose identity, generation,
  and admission sequence fence every connection and mutation.
- `@meridian/agent-edit` owns schema-safe mutation, the pure `diff` core (review
  projection, rebase, late-peer recovery) and forward inverse computation. This
  domain owns authorization, persistence, coordination, settlement, and trail
  projection around that core.

## Decision-changing rules

- Keep dependencies one-way: collab adapters import `@meridian/agent-edit`; the
  package must not import server code.
- Admit novel writer content durably before Yjs apply, broadcast, or ack. Route
  live and branch writes through their coordinator-owned admission seams.
- Reject writer updates with reserved client IDs or mutations in the reserved
  provenance namespace (including `review_base`) before durable append or Yjs
  apply.
- Yjs merge is trusted. Destructive effects inform marks and receipts but never
  veto an otherwise valid merge; undo recovers.
- Branch Y.Docs use `gc: false`: Apply rebuilds the writer's review frame from a
  `Y.snapshot`, and inverse classification needs the full struct history.
- Every server write into a text branch (seed, rebase, Apply's base patch, late
  recovery) is computed against the state it compare-and-swaps onto, under the
  branch lease, through the one `writeBranchState`. Never store a server-client
  delta and replay it later: its struct ids collide with the next write of
  client 1, and Yjs drops the replay silently.
- `has_effect` is `review_base ≠ prosemirror`, written by every branch write
  through that same capability so the Work projection sees it. Never compute it
  elsewhere or derive membership from journal rows.
- Any content apply after an `await` must obey the documented WebSocket
  concurrency fence. Do not assume a coordinator lock excludes socket writes.
- Model reads and writes go through the thread-peer pool with a caller-computed
  destination; nothing in collab decides live versus draft from a thread's
  mode. Scratch and uploads are never drafted, and `ensureDraftBranch`
  throws if asked to.
- A reply saves once: every document it wrote, live or drafted, in one
  transaction. Live text reaches open editors only after commit.
- Derive live read models from a journal-locked durable cut, never a warm room
  paired with a database watermark. The recovery sweep owns freshness; triggers
  only reduce latency. Push derivation joins its completion transaction.
- Route schema-aware content reads, seeds, and writes through
  `domain/markdown-document.ts`.
- Build the markup codec once, in `domain/agent-edit-runtime.ts`, where the
  composition root injects `DocumentLinkScopes`. Links and image sources spell
  from the document tree per operation (`domain/document-link-scope-doors.ts`
  opens the scope, the operation prepares it before its synchronous
  serialize), never cached; a new door that hands Markdown to a reader joins
  that scope and prepares. Spelling outside every scope, or from a scope no
  door prepared, throws under test and logs `serialize.link_unscoped` /
  `serialize.link_snapshot_miss` in production. Parse is pure syntax: writes
  assign written image paths' `asset:` srcs in agent-edit's ref assignment
  (`assignLinkRefs`) after it.

Deep contracts and verification guidance live in [`.context/CONTEXT.md`](.context/CONTEXT.md).
For an end-to-end visual tour of the domain, read [`.context/collab-domain.html`](.context/collab-domain.html).
Related boundaries: [`domains/notices`](../notices/AGENTS.md) and
[`@meridian/agent-edit`](../../../../../packages/agent-edit/AGENTS.md).

## Immutable edit capture and forward inverses

`adapters/drizzle-document-edits.ts` captures model and journaled writer writes
inside their existing mutation transactions and locks. Each logical model edit
reserves one ordinal before staging; capture receives that same ordinal for its
immutable row, so results, receipts and journal parts name the same edit. Response
and turn grouping do not allocate or merge handles. Parts retain delta bytes
independently of journal compaction.

A part's placement is `pending` (in a text branch), `live` or `discarded`. Content
Apply moves no part: whether an edit's text has been applied is derived from the
draft's text (`draft-edit-status.ts`: applied when it lies in no review change,
pending when it lies inside one). Item Discard and Discard all make the closed
branch's pending parts `discarded`, terminal.

Two inverse paths use these immutable parts and the forward inverse primitive:
the model's `write revert` and failed-response rollback. `revert` is a new edit
in the thread's current destination (the active draft's text branch, ensured and
seeded if absent, or live); in a draft it shows as a change the writer applies.
Pending inverses in a draft hold root identities against inverses elsewhere, and
their writes use ordinary journal rows, never status reversal or row replacement.
Only inverse policies acquire the outer transition lock. Stored `undo` and `redo`
edit kinds remain readable history; nothing writes them.

`has_effect` and `blocking` decide whether an edited item is listed (see
[Membership in `branch-model-and-records.md`](.context/branch-model-and-records.md#membership)).
A skipped inverse hold marks its draft blocking so the item stays reachable even
when its text equals its base.

Save and rollback take `ModelResponseIdentity`, never a string that could mean
either provider response or helper scope. `document_edits.response_id` retains
provider authorship; `edit_scope_id` selects the rotated scope. Failed-scope
rollback includes its durable `revert` edits. Provider FKs are unchanged.

Model edit inspection shares one invocation-local context per immutable view:
prepared lineage and classifications, with a shared rollback-membership index
for that history. Display placement and current-destination admission remain
separate views. Every scratch advance invalidates its context before the next
planned step. Never retain these contexts across invocations or document
mutation.

Model `revert` targets one immutable edit by handle. It plans on a scratch copy,
reverts the parts and blocks the writer left alone, and reports the rest
("revert 1 of 2"); with nothing left it refuses `nothing_to_revert` and mutates
nothing. All inverse edits retain the shared edit scope for failed-scope
rollback.
