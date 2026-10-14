# domains/collab — server-side branch collaboration

This domain composes `@meridian/agent-edit` with Meridian persistence and
Hocuspocus transport. It owns durable live and branch Yjs infrastructure, not
editor UI or transport-shell policy.

## Mental model

- Live documents, per-thread peers, and per-Work review drafts are real Y.Docs.
  Sync propagates between them; journals are durable and runtime state is
  reconstructible.
- A Work draft is shared by every thread editing the same document in that Work.
  Document Apply publishes its whole current branch. Per-change Apply and Discard
  share server-vended dependency-closed classes, never client-reconstructed turns.
  Per-change Apply fences both preview revisions. Discard fences the live revision
  and server-vended evidence of complete closed rows and rich class effect, not
  unrelated draft typing. Both
  use current-cut snapshot CAS at durable commit; document Apply and whole
  Discard remain unfenced.
- Writer source rows retain their identities through attribution. Only dependency
  closure owns change membership; block proximity never joins writer edits.
- Independent deleting edits from separate chats stay separate: forward writes
  and Work publication journal transaction deltas, not cumulative state-vector
  tombstones. Keep genuine dependency closure, including retained cumulative rows
  and same-client clock prefixes. Draft agent writes use one fresh client and one
  journal row per paragraph per logical write, atomically published per reply.
  Recognized adjacent splits/merges and contiguous inserted/removed runs stay one
  segment. Independent writes never join merely for sharing a paragraph.
- Each live document has a durable authority head whose identity, generation,
  and admission sequence fence every connection and mutation.
- `@meridian/agent-edit` owns schema-safe mutation and forward inverse computation. This
  domain owns authorization, persistence, coordination, settlement, and trail
  projection around that core.

## Decision-changing rules

- Keep dependencies one-way: collab adapters import `@meridian/agent-edit`; the
  package must not import server code.
- Admit novel writer content durably before Yjs apply, broadcast, or ack. Route
  live and branch writes through their coordinator-owned admission seams.
- Reject writer updates with reserved client IDs or mutations in the reserved
  provenance namespace before durable append or Yjs apply.
- Yjs merge is trusted. Destructive effects inform marks and receipts but never
  veto an otherwise valid merge; receipt Undo/Redo remains reversal authority.
- Branch Y.Docs use `gc: false`; inverse classification requires their full
  struct history.
- Any content apply after an `await` must obey the documented WebSocket
  concurrency fence. Do not assume a coordinator lock excludes socket writes.
- Model reads and writes go through the thread-peer pool with a caller-computed
  destination; nothing in collab decides live versus draft from a thread's
  mode. Scratch and uploads are never drafted, and `ensureWorkDraftBranch`
  throws if asked to.
- A reply saves once: every document it wrote, live or drafted, in one
  transaction. Live text reaches open editors only after commit.
- Derive live read models from a journal-locked durable cut, never a warm room
  paired with a database watermark. The recovery sweep owns freshness; triggers
  only reduce latency. Push derivation joins its completion transaction.
- Route schema-aware content reads, seeds, and writes through
  `domain/markdown-document.ts`.
- Downloads and project ZIPs use the explicit `readForExport` door with a
  frozen export scope and separate export codec. Never route model reads
  through it or rewrite stored links for export.
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
independently of journal compaction. Apply moves placement at completed admission
to the authored live row, not the reconcile row; Discard and empty-draft reset
make discarded and retired placements terminal. Per-change Discard re-forks from
live and surviving journal rows with their immutable edit/part identity; it
creates no inverse edit or restoration copy. Card Undo/Redo and failed-response rollback use these immutable parts and the
forward inverse primitive. Card authorization and change-viewer discovery share immutable edit/placement
targets with inverse admission; mutation and branch transport journals are not
authorization lineage. The card's control is a dry run of that same policy,
Redo first; one action lands in one view per document. Pending inverses in a
draft hold root identities against inverses elsewhere. Their writes use ordinary
journal rows, never status reversal or row replacement. Only inverse policies
acquire the outer transition lock. Model `write undo/redo/revert` and `read(format: "edits")` use the same immutable
store through `model-document-edits.ts`. `model-inverse-policy.ts` owns one
all-or-nothing stack per thread/document, with action-history pops, consumed
undo actions and current-destination admission. User-actuated entries refuse
model stack commands; revert is a new edit in the current destination.

`hasEffect` compares prose plus managed manifest membership to the draft's durable
`liveCut` (the last pulled live state), using `documentEffectsEqual`. Prose review
and publication use `documentProseEqual`; manifest review operations are separate.
Pending lists and Work notifications read this flag or `blocking`; journal row
count alone is not visible effect. A skip marks a holding draft blocking so its
Apply/Discard remains reachable even when its prose equals live.

Save and rollback take `ModelResponseIdentity`, never a string that could mean
either provider response or helper scope. `document_edits.response_id` retains
provider authorship; `edit_scope_id` selects the rotated scope. Failed-scope
rollback includes its durable undo, redo and revert edits and restores stack
availability from non-rolled-back actions. Provider FKs are unchanged.

Model edit inspection shares one invocation-local context per immutable view:
prepared lineage and classifications, with a shared rollback-membership and
effective-action index for that history. Display placement and current-destination
admission remain separate views. Redo preview reuses the locked inspection;
every scratch advance invalidates its context before the next planned step.
Never retain these contexts across invocations or document mutation.

Model inverse `count` measures edits in both directions. Multi-edit Undo plans
on a scratch copy, admits atomically, and stores one action per target edit.
Redo restores the last undone edit first; insufficient counts refuse with the
available count and no mutation. All actions retain the shared edit scope for
failed-scope rollback. Card grouping and writer-only redo are unchanged.
