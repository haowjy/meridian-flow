# Draft review reversal contract

Accepted draft writes are undone through the live `agent-edit` reversal path, not a draft-specific inverse engine.

- Full accepts use the durable write id `draft-accept:<draftId>:<acceptGeneration>`.
- Partial accepts use `draft-accept:<draftId>:<acceptGeneration>:op:<hash>`, where the hash is over the accepted operation closure.
- `agentEditCore.reverse()` accepts either that durable write id or the visible write handle (`w<N>`). Planning resolves durable ids through `agent_edit_mutations`, but persisted `document_yjs_reversals.write_id` rows store the canonical handle (`w<N>`). Seeing `w1` in `document_yjs_reversals` for a draft accept is expected; the durable id remains on `agent_edit_mutations.write_id`.
- Partial accept now journals the accepted live mutation before applying it to the live coordinator, matching the full-accept order. The pre-append dry-run only verifies that the selected Yjs update has a real live effect; it does not mutate live state.
- Cold undo reconstruction refuses empty Yjs inverse updates before persistence. A failed no-op reverse must not append a system journal update or mark the mutation reversed; draft undo then returns conflict and restores the draft from `reactivating` back to `active`.
