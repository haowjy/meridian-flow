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
The selected turn normalizes to the last settled turn at or before it in the
effective transcript. A delivered user turn is a valid cutoff while its reply
streams; queued user turns are beyond that boundary. A selection with no settled
prefix is refused. Subagent sources are refused, and an inherited cutoff keeps
its owning source thread.

Returns the destination Thread (201 new, 200 existing). Reusing an id is a
no-op when the row belongs to the same owner/project and is a primary handoff.
Changed selection arguments do not overwrite it. Other reuse returns 409.

Creation commits the destination, one pending system seed S, and the source's
`agent.handoff` event in one transaction. After commit, `HandoffBriefs` launches
the brief independently. There is no inbox control or run lease for S. The
destination cannot start a run while S is pending; writer messages sent in the
meantime remain chained after S and are answered when it settles. A failure or
Stop also releases the gate and wakes the destination.

## Seed data and actions

S has `metadata.kind = derivation_seed`, `derivation = handoff`,
`sourceThreadId`, frozen `sourceRef` and `sourceTitle`, `cutoffTurnId`, and the
recovery counter `launches`. A pending seed is not a current run turn and has
no lease phase. A terminal seed's custom block has kind `handoff-brief` and
props `state` (`available` or `unavailable`), `brief`, `sourceThreadId`,
`sourceRef`, frozen `sourceTitle`, `cutoffTurnId`, `model`, and frozen
`modelText`.

Stop uses `POST /api/threads/:threadId/turns/:turnId/cancel` with S's id. It
settles a pending S directly; it does not cancel a destination run. The brief
worker observes remote Stop within its 5-second status poll. A queued destination
message remains available after Stop.

Retry is a direct append operation, not a control:

```http
POST /api/threads/:threadId/handoff/brief
Content-Type: application/json
```

```json
{ "id": "client-minted-retry-seed-uuid" }
```

The route returns 201 for a new seed or 200 for an idempotent replay. The new
seed is appended at the destination leaf with frozen source fields copied from
the previous seed; it does not look up the source. It launches after commit.
The latest seed must be `error` or `cancelled`, and the destination must have
no live run lease. The server returns 409 `handoff_retry_unavailable` while a
brief is pending, after success, or while a destination reply is live; it
returns `not_a_handoff_retry` for a non-handoff thread and `seed_id_conflict`
when the client id belongs to another row.

## Brief generation and accounting

The server loads the source's effective transcript through the cutoff and
prepares one source-shaped request. It preserves the source bake and baked tools
at that turn. Model and thinking settings use the source's current binding.
The request is branched at every cutoff, warm or cold, and appends an
instruction naming the incoming Agent. For a writer message with no answer, the
instruction says: “report it as the open request; do not answer it.” A branch
failure falls back once to the shared rolling summarizer; source preparation
failure uses that fallback directly. Stop does not fall back. The destination
receives only S's frozen brief and source reference, never the source transcript.

Seed metadata stores `summarizer: { path: "branch" | "rolling", segments }`.
Failure phases are `launch`, `source_prepare`, `summary`, `settle`, and
`recovery`; reasons include the shared summary rejections,
`credits_exhausted`, `handoff_brief_failed`, and `interrupted`. The journal's
`turn.error` uses code `handoff_brief_failed` with the typed reason and phase in
`details`; writer copy remains generic.

Every returned provider attempt, including failed attempts, is settled on S
with its cache prediction, usage and debit. These system-turn rows never make
the destination's first reply predict warmth or supply its token baseline. The
brief does not write compaction metadata or start a prompt epoch.

While S is pending, the thread status reader reports `awake/generating` with
`runningTurnId: null`; this is a working indicator, not a run lease. Launch and
settlement publish a `thread.status` refresh. A recovery sweep relaunches
pending seeds under a process-shared claim; repeated crashes are bounded by
three launches, after which S settles as interrupted and can be retried.
