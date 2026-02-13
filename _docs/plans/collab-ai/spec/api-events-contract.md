---
detail: standard
audience: developer, architect
---
# Collaboration Spec: API and Event Contract

**Status:** Draft  
**Purpose:** Define external contracts for transport, proposal lifecycle, and changeset discoverability.

## WebSocket Protocol

```typescript
// Client -> Server
| { type: "getDocument" }
| { type: "pushUpdates"; version: number; updates: { clientID: string; changes: number[] }[] }
| { type: "pullUpdates"; version: number }
| { type: "getUndoTail" }

// Server -> Client
| { type: "document"; eventId: number; version: number; doc: string }
| { type: "updates"; eventId: number; version: number; updates: { clientID: string; changes: number[]; source: string }[] }
| { type: "pushResult"; eventId: number; ok: boolean; version?: number; error?: string }
| { type: "resetRequired"; eventId: number; snapshotVersion: number }
| { type: "undoTail"; eventId: number; ops: { version: number; changes: number[]; clientID: string }[] }
| { type: "newProposal"; eventId: number; proposal: Proposal }
| { type: "proposalStatusChanged"; eventId: number; proposalId: string; status: "rejected" | "conflicted" }
| { type: "proposalRemoved"; eventId: number; proposalId: string; operationId: string; version: number }
```

Ordering and reconciliation rules:
- `eventId` is strictly increasing per document session.
- Clients process events in `eventId` order; gaps trigger `pullUpdates` plus proposal/status refresh.
- For accept path, `updates.version` and `proposalRemoved.version` must match the inserted authoritative operation version.

## Protocol Error Contract (v1)

| Code | Meaning | Client Behavior |
|---|---|---|
| `VERSION_GAP` | client version behind floor/head expectations | issue `pullUpdates`; if repeated, reconnect |
| `RESET_REQUIRED` | requested version `< collab_op_floor_version` | reload snapshot, reconnect from `collab_snapshot_version` |
| `IDEMPOTENCY_REPLAY` | same (`client_id`, `client_op_id`) already applied | treat as success, refresh head version |
| `PAYLOAD_TOO_LARGE` | op/proposal exceeds limits | chunk and retry |
| `PROPOSAL_CONFLICTED` | proposal cannot be safely rebased | show conflicted state, regenerate |
| `IDEMPOTENCY_KEY_CONFLICT` | same idempotency key reused with different payload | treat as hard error, generate new key |
| `TICKET_INVALID` | ticket missing/expired/used | fetch new ticket and reconnect |
| `RATE_LIMITED` | per-connection or per-doc limits exceeded | exponential backoff (start 250ms, cap 5s) |
| `COLLAB_DISABLED` | kill switch enabled | switch UI to read-only mode |

## Auth and Session Establishment

- Ticket endpoint: `POST /api/documents/{id}/ws-ticket` (Go backend, JWT-authenticated).
- WS endpoint: `wss://collab-ai.meridian.app/ws/documents/{documentId}?ticket={ticket}`.
- Ticket TTL: 30 seconds, one-time redeem.
- Redeem must be atomic:
  - validate `used = false` and `expires_at > now()`
  - mark `used = true` within same statement/transaction
  - fail closed on replay/race

## Proposal Lifecycle APIs

- `GET /api/projects/{id}/proposals?status=proposed&cursor=`
- `GET /api/documents/{id}/proposals?status=&cursor=`
- `GET /api/proposals/{id}`
- `GET /api/proposal-groups/{groupId}`
- `GET /api/projects/{id}/proposal-status`
- `POST /api/proposal-groups/{groupId}/accept`

Response requirements:
- Provenance: `threadId`, `turnId`, `agentRunId`, `producerAgentType`
- Linkability: `proposalGroupId`, `baseVersion`, `status`
- Cursor fields: `createdAt`, `id`

Permission contract:
- `owner`/`editor`: create proposals, accept, reject, group-accept.
- `viewer`: read-only query access.
- v1 single-writer mode satisfies this with one authenticated owner/editor.

## Authoritative Changeset Query APIs

- `GET /api/projects/{id}/changesets?origin=user|ai_accepted&cursor=`
- `GET /api/documents/{id}/changesets?origin=user|ai_accepted&cursor=`

Changeset response must include:
- `kind` (`operation` | `segment`)
- For `kind='operation'`: `operationId`, `version`, `origin`, `changeset`, `createdAt`, `userId`
- For `kind='segment'`: `segmentId`, `fromVersion`, `toVersion`, `entryCount`, `composedChangeset`, `origins`, `createdAt`
- For accepted AI: `sourceProposalId`, `threadId`, `turnId`, `agentRunId`, `producerAgentType`

Writer timeline contract:
- Default timeline is merged authoritative history (`origin=user|ai_accepted`) sorted by `version DESC`.
- UI exposes origin filters; default remains merged so accepted AI edits are first-class in writer history.
- Compaction can collapse older authoritative ops into `segment` entries; recent tail remains raw `operation` entries.
- Accepted AI edits, once promoted, follow the same authoritative compaction path as human edits.

## Accept/Reject/Conflict Contract

Accept (`POST /collab/proposals/{id}/accept`):
1. Rebase proposal changeset against current head.
2. Insert authoritative op (`origin='ai_accepted'`).
3. Remove proposal row.
4. Broadcast `updates` + `proposalRemoved`.
5. Return `{ proposalId, operationId, version }`.

Accept idempotency and replay:
- Client sends `Idempotency-Key` on accept and group-accept requests.
- Replayed accept for same proposal must return the originally created `{ operationId, version }` without side effects.
- Conflicting reuse of an idempotency key (different proposal/group payload) returns `409`.
- Single-accept enforcement is backed by storage uniqueness on `sourceProposalId` in authoritative operations.

Reject:
- Mark proposal `rejected` and emit `proposalStatusChanged`.

Conflict:
- Mark proposal `conflicted` and emit `proposalStatusChanged`.

Group-accept semantics (`POST /api/proposal-groups/{groupId}/accept`):
- Proposals are processed in deterministic order (`created_at`, `id`).
- Default is `stop_on_conflict=true`: previously accepted chunks remain accepted; first conflicted chunk stops the remainder.
- Response returns per-proposal outcomes: `accepted | conflicted | skipped`.

Write-then-publish recovery:
- DB commit is authoritative; event publish is best-effort delivery.
- If publish fails after commit, API still returns success and clients reconcile via `pullUpdates` + proposal/status/changeset refresh.
- Retry publishing is allowed; consumers must de-dupe by `eventId`.

Compaction processing contract:
- Compaction and proposal-history rollups are asynchronous background jobs and must not block write/apply/accept API success.
- Compaction jobs are idempotent; retrying the same job must preserve correct `/changesets` output (no duplicate segment semantics).
- If compaction job execution fails, APIs continue to serve from raw operations/proposal rows until retry succeeds.

## Admission and Rate Contracts

| Limit | Default | Behavior on exceed |
|---|---|---|
| `max_changeset_bytes` | `128KB` | Split into chunk proposals |
| `max_changed_chars` | `20_000` | Split into chunk proposals |
| `max_changed_ranges` | `200` | Split into chunk proposals |
| per-op WS payload | `64KB` | Reject push, require chunking |

| Scope | Limit | Behavior |
|---|---|---|
| per WS connection inbound | `30` messages/sec | return `RATE_LIMITED`, temporary mute 1s |
| per document pending proposal accepts | `20` | reject new accepts until queue drains |
| per document queued agent proposals | `200` | reject lowest-priority new proposal |
| offline local queue (frontend) | `256KB` | stop queueing, show reconnect-required banner |

## Conflict Tiers

| Tier | Condition | Behavior |
|---|---|---|
| Low | Small overlap, hash still valid | Auto-rebase path allowed |
| Medium | Moderate overlap | Require user review before accept |
| High | Large overlap or hash mismatch | Mark `conflicted`, do not auto-apply |

## Related

- `_docs/plans/fb-realtime-collab-editing.md`
- `_docs/plans/collab-ai/spec/storage-model.md`
- `_docs/plans/collab-ai/spec/refresh-read-model-framework.md`
