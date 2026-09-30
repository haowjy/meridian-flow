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
The selected turn is the cutoff. Every effective transcript turn through it must
be settled. Hand off accepts a finished assistant reply or a delivered writer
turn; a reply that starts after the selected writer turn may still be streaming.
Queued writer turns follow an unsettled reply and are refused. Subagent sources
are refused, and an inherited cutoff keeps its owning source thread.

Returns the destination Thread (201 new, 200 existing). Reusing an id is a
no-op when the row belongs to the same owner/project and is a primary handoff.
Changed selection arguments do not overwrite it. Other reuse returns 409.

Creation uses this order: idempotent destination lookup; acquire the
destination's `RunClaim.hold`; create the destination, pending system seed S,
and source `agent.handoff` event in one transaction; then transfer the claim to
a detached brief after commit. The request returns when S commits, not when the
brief finishes. A rollback or other path that does not launch releases the
claim. If the lookup found nothing and the claim is held, the server creates
nothing and returns 409 `handoff_in_progress`; retrying after the creating
request commits replays the destination.

The brief holds the same destination run claim a reply uses, with no lease or
running-turn id. A run wake cannot start while it holds the claim. Writer
messages and controls remain in the durable inbox; brief release rereads the
queue and starts any runnable work. A pending S is a working indicator in
`thread.status` (`awake/generating`, `runningTurnId: null`), not a live lease.

## Seed data and actions

S has `metadata.kind = derivation_seed`, `derivation = handoff`,
`sourceThreadId`, frozen `sourceRef` and `sourceTitle`, and `cutoffTurnId`. A
terminal seed's custom block has kind `handoff-brief` and props `state`
(`available` or `unavailable`), `brief`, `sourceThreadId`, `sourceRef`, frozen
`sourceTitle`, `cutoffTurnId`, `model`, and frozen `modelText`.

Stop uses `POST /api/threads/:threadId/turns/:turnId/cancel` with S's id. It
settles a pending S directly under the destination lock; it does not cancel a
destination run. After the brief releases its claim, waiting messages run before any queued command. Stop gives no command special priority.
The brief worker observes remote Stop within its five-second status poll. A
queued destination message remains available after Stop.

Retry is a direct append operation, not a control:

```http
POST /api/threads/:threadId/handoff/brief
Content-Type: application/json
```

```json
{ "id": "client-minted-retry-seed-uuid" }
```

The route returns 201 for a new seed or 200 for an idempotent replay. It first
looks up that seed id, so replay returns the existing S2 without attempting to
acquire the claim. Otherwise it takes `RunClaim.hold`, appends S2 at the
destination leaf with frozen source fields copied from the previous seed, and
launches it detached after commit. The latest seed must be `error` or
`cancelled`. A held claim returns 409 `handoff_retry_unavailable`; this covers
a running brief or destination reply. The same code is returned when the latest
seed cannot be retried. The route returns `not_a_handoff_retry` for a
non-handoff thread and `seed_id_conflict` when the client id belongs to another
row.

## Brief generation and accounting

The server loads the source's effective transcript through the cutoff and
prepares one source-shaped request. It preserves the source bake and baked tools
at that turn. Model and thinking settings use the source's current binding.
The shared summary rule is known-too-large → rolling, warm → source-model
branch, cold → rolling. A network, provider, preparation, or summary failure is
final for that attempt; there is no fallback or relaunch. The instruction tells
the model to report an unanswered writer message as the open request, not to
answer it. The destination receives only S's frozen brief and source reference,
never the source transcript.

Seed metadata stores `summarizer: { path: "branch" | "rolling", segments }`.
Failure phases are `launch`, `source_prepare`, `summary`, and `recovery`; reasons
include shared summary rejections, `credits_exhausted`,
`handoff_brief_failed`, and `interrupted`. The journal's `turn.error` uses code
`handoff_brief_failed` with typed reason and phase in `details`; writer copy
remains generic.

Every returned provider attempt, including failed attempts, is settled on S
with its cache prediction, usage, and debit in the ending transaction. A
non-Stop abort settles paid rows while leaving S pending for repair. If the
ending transaction throws, it is not retried: the claim is released and orphan
repair settles S as `interrupted` with the unavailable card and history read
line. These system-turn rows never make the destination's first reply predict
warmth or supply its token baseline. The brief does not write compaction
metadata or start a prompt epoch.

Orphan repair treats S as an ordinary pending system placeholder after it
acquires the claim, writes `phase: recovery`, and publishes a status refresh.
There is no handoff sweep, special brief claim, or launch counter.
