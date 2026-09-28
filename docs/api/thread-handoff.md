# Thread handoff API

`POST /api/threads/:threadId/handoff` authenticates and owner-gates the source.

```json
{
  "id": "client-minted-destination-uuid",
  "originTurnId": "selected-turn-uuid",
  "agentSelection": {
    "catalogEntryId": "catalog-entry-uuid",
    "definitionRevisionId": "agent-revision-uuid"
  }
}
```

The body is strict: `summary`, missing/null cutoff and extra fields return 400.
Subagent sources are refused. Selection normalizes to the last settled turn at
or before it in the effective transcript. A selection with no settled prefix
is refused. The normalized turn's owner is the source.

Returns the destination Thread (201 new, 200 existing). Reusing an id is a
no-op when the row belongs to the same owner/project and is a primary handoff.
Changed selection arguments do not overwrite it. Other reuse returns 409.

Creation atomically inserts a pending system seed and its control, then wakes
the destination after commit. A writer can send immediately: their message
chains after S and is answered after the brief. Failure never drops that send.
The source's `agent.handoff` event names source, destination, Agent slug and
normalized `originTurnId`; it contains no summary.

## Seed data and actions

S has `metadata.kind = derivation_seed`, `derivation = handoff`,
`sourceThreadId`, frozen `sourceRef`, `cutoffTurnId`, and `controlMessageId`. While pending its
current-turn kind is `handoff_brief`, and its lease phase is `briefing`.
The first control additionally has `seedTurnId`; only creation sets this field.

A terminal seed's custom block has kind `handoff-brief` and props `state`
(`available` or `unavailable`), `brief`, `sourceThreadId`, `sourceRef`,
`cutoffTurnId`, `model`, and frozen `modelText`. Status is `complete`, `error`,
or `cancelled`. Stop uses the ordinary turn-cancel endpoint, even before any
run binds S. Withdrawal of the first control cancels S too.

Retry enqueues `{ "id": "new-uuid", "control": { "kind": "handoff_brief" } }`
through [the control API](thread-controls.md). It appends a new seed at the
execution leaf; no sent turn changes. Non-handoff destinations return 409.

C7a supplies the seed protocol and unavailable fallback. The provider-backed
brief, source cache handling and metered calls are C7b; the card and Retry UI
are C10. A C7a-only server therefore reports an unavailable brief, not a fake
summary.
