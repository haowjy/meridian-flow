# collab — Draft review (branch model)

> **The pre-branch draft subsystem is deleted.** `document_yjs_drafts`,
> `document_yjs_draft_updates`, `scope_id`, draft Hocuspocus rooms, the draft
> write-mode router, accept/reactivation lifecycle, and draft-scoped
> agent-edit state no longer exist.

Current review model: branches are real `Y.Doc` peers. The agent writes to a
thread-peer branch; the work-draft branch accumulates writes across threads
in the same Work. Review compares the work-draft `Y.Doc` with live.
Review cards are computed from `branch_write_journal` rows via
`branch-review-closure.ts`.

→ [`.context/CONTEXT.md`](CONTEXT.md) — branch model overview
→ [`AGENTS.md`](../AGENTS.md) — mental model and rules
→ [KB: Draft-Branch Topology](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/draft-branch-topology.md) — peer topology and invariants
→ [KB: Journal Staging and Durability](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/journal-staging-durability-states.md) — staging truth model
