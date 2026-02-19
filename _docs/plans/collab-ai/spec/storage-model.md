---
detail: standard
audience: developer, architect
---
# Collaboration Spec: Storage Model

**Status:** Draft
**Purpose:** Define canonical persistence model and invariants for Yjs-based collaboration.

## Canonical Invariants

- Document state is a Yjs CRDT (`Y.Doc`), stored as binary updates.
- Yjs binary state (`documents.yjs_state BYTEA`) is the **sole source of truth**. `documents.content` and `documents.ai_content` are **derived projections** — always computed from Yjs state, never written directly.
- Two logical concerns:
  - **Yjs document state**: the authoritative document (binary Yjs updates persisted to Postgres).
  - **AI/agent proposal queue**: non-authoritative Yjs update buffers awaiting writer review.
- On accept: apply Yjs update buffer to main `Y.Doc` via `Y.applyUpdate()`, then mark proposal row `status='accepted'` (terminal state, retained indefinitely as permanent audit record).
- No version allocation, no lease fencing — Yjs CRDTs are conflict-free by design.
- Accept/group-accept request idempotency must persist server responses by `Idempotency-Key` to return stable replay results.
- Provenance (agent_type, thread_id, etc.) is tracked on proposal rows for audit.
- Go backend uses `y-crdt` library to derive `content` and `ai_content` from Yjs state (via `ytext.ToString()`), persisted alongside `yjs_state` on every write.

## Architecture: Go-Only with y-crdt

All collab logic runs in the Go backend process. No separate Node service.

```
Browser ──HTTP──> Go Backend ──DB──> Postgres
Browser ──WS────> Go Backend (same process)
```

The Go backend uses [`skyterra/y-crdt`](https://github.com/skyterra/y-crdt) (MIT license) for Yjs operations:
- `NewDoc()`, `GetText()`, `GetMap()` — core doc operations
- `ApplyUpdate()` / `EncodeStateAsUpdate()` — persistence, proposal accept
- `EncodeStateVector` / `DecodeStateVector` — sync protocol
- `ytext.ToString()` — text extraction for search/preview

## Domain Structure

The collab domain follows the existing Go backend pattern with its own namespace:

```
backend/internal/
├── domain/
│   ├── models/collab/          # Collab domain models
│   ├── services/collab/        # Collab service interfaces (including DocumentResolver)
│   └── repositories/collab/    # Collab repo interfaces
├── service/collab/             # Business logic impl
├── repository/postgres/collab/ # Data access impl
└── handler/collab.go           # WS upgrade endpoint (self-contained)
```

The **only cross-domain dependency** is `DocumentResolver` (doc ID lookup + ownership verification). On extraction to a separate service: swap the direct-call impl for an HTTP client impl — no other cross-domain wiring needed.

## SQL Prefix Convention (Required)

1. Environment prefix comes from `TABLE_PREFIX` (for example: `dev_`, `stg_`, `prd_`).
2. Tables: `${TABLE_PREFIX}collab_document_edit_proposals`, `${TABLE_PREFIX}collab_document_snapshots`, `${TABLE_PREFIX}collab_request_idempotency`.
3. Indexes/constraints: `${TABLE_PREFIX}idx_collab_*`, `${TABLE_PREFIX}uq_collab_*`, `${TABLE_PREFIX}fk_collab_*` when explicitly named.
4. New migration files should include `collab` in filename for ownership clarity.

## User ID Convention

All `user_id` / `created_by_user_id` / `decided_by_user_id` columns use `UUID`. Supabase auth IDs are UUID-formatted; the Go handler boundary parses the JWT string into `uuid.UUID` (see `parseUUID()` in `handler/helpers.go`).

## Yjs Document Persistence

Yjs document state is stored as binary in Postgres on the `documents` table:

- `documents.yjs_state BYTEA` — sole source of truth, stores `Y.encodeStateAsUpdate(doc)`.
- `documents.content TEXT` — writer's view, derived via `doc.GetText("content").ToString()`. Used for search/indexing, export, and API responses.
- `documents.ai_content TEXT` — AI's view (document with all pending proposals applied), derived by cloning `Y.Doc` + applying all `status='proposed'` proposal updates + `ToString()`. Used for AI agent search and context.

### Snapshot Strategy

- **When:** 2s debounce timer (resets on each Yjs update) + every N Yjs updates (e.g., 500) as safety net + on WebSocket disconnect (last client).
- **What:** All three columns persist in one `UPDATE`: `yjs_state` + derived `content` + derived `ai_content`.
- **First-load:** Read `yjs_state`, apply via `Y.applyUpdate()`. Yjs sync protocol handles any updates since snapshot.
- **Derived columns:** Both `content` and `ai_content` are computed from Yjs state at persist time — no dual-write drift because they are always derived FROM the binary, never written independently.

### Derived Text Columns

Both `content` and `ai_content` are **read-only projections** — never written to directly by API consumers.

| Column | View | Updated When | Derivation |
|--------|------|-------------|------------|
| `yjs_state` | Binary CRDT (authority) | 2s debounce + disconnect + every N updates | `Y.encodeStateAsUpdate(doc)` |
| `content` | Writer's text | Same as `yjs_state` | `doc.GetText("content").ToString()` |
| `ai_content` | AI's text (doc + pending proposals) | Same as `yjs_state` + proposal lifecycle | Phase 1: same as content. Phase 3+: Clone doc -> apply all `status='proposed'` updates -> `ToString()` |

**Persistence triggers (all three columns written together in one UPDATE):**
- **2s debounce timer** — resets on each Yjs update, fires 2s after last activity
- **Every N updates (e.g., 500)** — safety net for long editing sessions
- **On disconnect** — final persist when last client disconnects
- **On proposal lifecycle** — `ai_content` also recomputed when proposals are created/accepted/rejected (Phase 3+)

**Scaling note:** v1 writes directly to Postgres via `DocumentStore` interface. v2 scaling requires only a `DocumentBroadcaster` swap (in-memory -> Redis pub/sub). Optionally, a Redis write-through cache could be added in front of `DocumentStore` for sub-second durability, but this is **not** part of the v1->v2 scaling path — it's an independent optimization if Postgres write latency becomes a bottleneck.

### Search and Preview Read-Model Contract

- `documents.content` serves search/indexing, export, and API responses directly from Postgres (no Yjs decode overhead per request).
- `documents.ai_content` serves AI agent search — the AI view with all pending proposals applied.
- Both are always rebuildable from Yjs state and are never authoritative write targets.

See `_docs/plans/collab-ai/spec/compaction-retention.md` for full snapshot policy.

## Document Snapshots (History/Restore)

Named restore points and periodic safety snapshots are stored in a dedicated table, not on the `documents` row.

```sql
CREATE TABLE ${TABLE_PREFIX}collab_document_snapshots (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    yjs_state       BYTEA NOT NULL,        -- Y.encodeStateAsUpdate(doc) at snapshot time
    snapshot_type   TEXT NOT NULL DEFAULT 'auto'
                    CHECK (snapshot_type IN ('auto', 'named', 'pre_restore')),
    name            TEXT,                   -- writer-provided name (for 'named' snapshots)
    created_by_user_id UUID,                -- NULL for auto snapshots
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ${TABLE_PREFIX}idx_collab_snapshot_doc_created
    ON ${TABLE_PREFIX}collab_document_snapshots(document_id, created_at DESC);

CREATE INDEX ${TABLE_PREFIX}idx_collab_snapshot_type_created
    ON ${TABLE_PREFIX}collab_document_snapshots(snapshot_type, created_at DESC);
```

Snapshot types:
- `auto` — periodic safety snapshots (every N updates, on disconnect).
- `named` — writer-created restore points ("Chapter 3 before rewrite").
- `pre_restore` — auto-created before applying a restore, so the restore itself is reversible.

## AI/Agent Proposal Schema (Yjs Update Buffers)

```sql
CREATE TABLE ${TABLE_PREFIX}collab_document_edit_proposals (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id           UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    source                TEXT NOT NULL DEFAULT 'ai'
                          CHECK (source IN ('ai', 'template', 'user_suggestion')),
    producer_agent_type   TEXT NOT NULL,
    thread_id             UUID NOT NULL,  -- denormalized provenance (no FK; must survive thread cleanup)
    turn_id               UUID,           -- denormalized provenance (no FK; must survive turn cleanup)
    agent_run_id          UUID NOT NULL,
    proposal_group_id     UUID,
    status                TEXT NOT NULL DEFAULT 'proposed'
                          CHECK (status IN ('proposed', 'accepted', 'rejected')),
    yjs_update            BYTEA NOT NULL, -- Yjs update buffer (Y.encodeStateAsUpdate())
    description           TEXT,
    created_by_user_id    UUID NOT NULL,
    decided_by_user_id    UUID,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    decided_at            TIMESTAMPTZ
);
```

**Key changes from previous draft:**
- `status` now includes `'accepted'` — proposals use terminal status instead of hard-delete.
- Accepted and rejected proposals are retained indefinitely as permanent audit records: who accepted/rejected what, when, and the original Yjs update.

## Proposal Grouping Semantics

- `proposal_group_id` is assigned by the proposal creator and is immutable after creation.
- A proposal can belong to exactly one group (`proposal_group_id` set) or none (`proposal_group_id IS NULL`).
- All proposals in a group must exist before group-accept starts. Group-accept snapshots the group membership at transaction start.
- Group membership is determined by querying `WHERE proposal_group_id = $1 AND status = 'proposed'` within the transaction snapshot.

## Proposal Query Indexes (Required)

```sql
CREATE INDEX ${TABLE_PREFIX}idx_collab_proposal_doc_status_created
    ON ${TABLE_PREFIX}collab_document_edit_proposals(document_id, status, created_at DESC);

CREATE INDEX ${TABLE_PREFIX}idx_collab_proposal_group_status
    ON ${TABLE_PREFIX}collab_document_edit_proposals(proposal_group_id, status);

CREATE INDEX ${TABLE_PREFIX}idx_collab_proposal_status_created
    ON ${TABLE_PREFIX}collab_document_edit_proposals(status, created_at DESC);

CREATE INDEX ${TABLE_PREFIX}idx_collab_proposal_thread_turn
    ON ${TABLE_PREFIX}collab_document_edit_proposals(thread_id, turn_id, created_at DESC);
```

## Request Idempotency Schema (Required)

```sql
CREATE TABLE ${TABLE_PREFIX}collab_request_idempotency (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID NOT NULL,
    idempotency_key  TEXT NOT NULL,
    request_scope    TEXT NOT NULL CHECK (request_scope IN ('proposal_accept', 'group_accept')),
    scope_id         UUID NOT NULL, -- proposal_id or proposal_group_id depending on request_scope
    request_hash     TEXT NOT NULL, -- stable hash of normalized request body
    document_id      UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    response_payload JSONB NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at       TIMESTAMPTZ NOT NULL,

    UNIQUE(user_id, idempotency_key)
);

CREATE INDEX ${TABLE_PREFIX}idx_collab_idempotency_scope
    ON ${TABLE_PREFIX}collab_request_idempotency(request_scope, scope_id, created_at DESC);

CREATE INDEX ${TABLE_PREFIX}idx_collab_idempotency_expires
    ON ${TABLE_PREFIX}collab_request_idempotency(expires_at);
```

Rules:
- `request_hash` = SHA-256 hex of canonical JSON: sorted keys, no whitespace, UTF-8 encoded.
- Same `(user_id, idempotency_key)` + same `request_hash` returns stored `response_payload` with no side effects.
- Same `(user_id, idempotency_key)` + different `request_hash` is `IDEMPOTENCY_KEY_CONFLICT` (`409`).
- Cleanup is asynchronous (`expires_at`-driven); TTL is defined by API contract.

`response_payload` structure by scope:
- `proposal_accept`: `{ "proposalId": "uuid" }`
- `group_accept`: `{ "outcomes": [{ "proposalId": "uuid", "status": "accepted|skipped", "error?": string }] }`

## Proposal State Machine

```
proposed --> accepted   (Yjs update applied to main Y.Doc, proposal row marked terminal `status='accepted'`)
proposed --> rejected   (terminal; decided_by_user_id + decided_at set)
```

State rules:
- `proposed` is the only mutable state. All transitions out of `proposed` are final.
- `rejected` is terminal — no re-opening or re-proposing from the same row. Row retained indefinitely.
- `accepted` is terminal — Yjs update has been applied to the main document. Row retained indefinitely as permanent audit record.
- Both `accepted` and `rejected` rows set `decided_by_user_id` and `decided_at`.

## Auto-Accept Configuration (Tri-State Cascade)

Each level is `true | false | null` (null = "no opinion, defer to next level").

```
Resolution order (most specific wins):
  Agent -> Project -> User -> System default (false)
```

| Agent | Project | User | Result | Why |
|---|---|---|---|---|
| `null` | `true` | `null` | `true` | Project decided |
| `false` | `true` | `null` | `false` | Agent overrode project |
| `null` | `null` | `true` | `true` | User default applied |
| `null` | `null` | `null` | `false` | System default (require review) |

When resolved to `true`, the proposal is immediately applied to the authoritative Yjs doc — no review step. The writer can still undo via `Y.UndoManager`.

### Auto-Accept Storage

Each level stores a nullable boolean on its respective entity:

| Level | Storage | Location |
|---|---|---|
| Agent | Agent type configuration (runtime/DB) | `auto_accept_proposals BOOLEAN` (nullable) |
| Project | `projects` table | `auto_accept_proposals BOOLEAN` (nullable) |
| User | `user_preferences.preferences` JSONB | `preferences->'collab'->>'auto_accept_proposals'` (nullable) |
| System | Environment variable or app config | `MERIDIAN_COLLAB_DEFAULT_AUTO_ACCEPT` (default: `false`) |

`NULL` means "no opinion, defer to next level." `true`/`false` is an explicit decision that overrides lower-priority levels.

## AI Proposal Model: Two Views, One Truth

```
Yjs Doc (authoritative)
  |-- Writer View: sees diff decorations for pending AI changes
  |-- AI View: sees the document WITH all pending AI changes applied
```

AI proposals aren't "held separately" from AI's perspective. The AI stream treats proposals as already-applied. The human sees them as pending diffs. Auto-accept configuration controls whether the review step is skipped.

## Scaling Interfaces

```go
// Connection is the transport-agnostic interface for a connected client.
// v1: *WSConn satisfies this. Tests and future transports (SSE, Redis relay) provide their own.
type Connection interface {
    ID() string
    Send(data []byte) error
}

// DocumentBroadcaster handles fan-out of Yjs updates to connected clients.
// No single-user assumption — designed for N clients per document from the start.
// v1: in-process map of connections
// v2: Redis pub/sub for multi-instance
type DocumentBroadcaster interface {
    Subscribe(docID string, conn Connection) error
    Unsubscribe(docID string, conn Connection)
    // Broadcast sends update to all connections for docID.
    // exclude may be nil to broadcast to ALL connections (e.g., server-generated updates).
    Broadcast(docID string, update []byte, exclude Connection)
}

// DocumentStore handles Yjs state persistence.
// v1: direct Postgres
// v2: could optionally add Redis write-through cache (see Scaling note above)
type DocumentStore interface {
    LoadState(ctx context.Context, docID string) ([]byte, error)
    // SaveState persists yjs_state + derived content + derived ai_content in one UPDATE.
    SaveState(ctx context.Context, docID string, state []byte, content string, aiContent string) error
}

// DocumentCompactor handles compaction of Yjs state (deferred optimization).
// Implementations that support compaction satisfy both DocumentStore and DocumentCompactor.
// See _docs/future/ideas/performance/yjs-periodic-compaction.md for trigger thresholds.
type DocumentCompactor interface {
    // ReplaceState atomically swaps the stored Yjs state with a compacted version.
    // Content and aiContent are re-derived.
    ReplaceState(ctx context.Context, docID string, compactedState []byte, content string, aiContent string) error
}
```

v1 -> v2 scaling path requires **no core logic changes** — only the `DocumentBroadcaster` implementation swaps (in-memory map -> Redis pub/sub).

```go
// DocumentResolver is the thin boundary between collab and the document domain.
// v1: direct service call | v2 (extracted service): HTTP client
type DocumentResolver interface {
    ResolveDocument(ctx context.Context, docID string) (*CollabDocRef, error)
    VerifyOwnership(ctx context.Context, docID string, userID string) (bool, error)
}
```

### Y.Doc Memory Management (v1)

The Go backend holds `Y.Doc` instances in memory for documents with active WebSocket connections.

- **Load:** When the first client connects to a document, load `yjs_state` from Postgres and create an in-memory `Y.Doc`.
- **Evict:** When the last client disconnects, persist the current state (snapshot) and release the in-memory `Y.Doc`.
- **No idle timeout:** v1 keeps docs in memory only while connections exist. No LRU or memory cap.
- **Reconnect:** If a client reconnects after eviction, the doc is reloaded from Postgres (normal first-load flow).

### Compaction Readiness

`Y.encodeStateAsUpdate(doc)` produces a self-contained representation of document state, but retains CRDT tombstones that grow over time. See `_docs/future/ideas/performance/yjs-periodic-compaction.md` for mitigation. The `ReplaceState` method on `DocumentCompactor` supports atomic swap of the stored state with a compacted version. This means compaction is a simple periodic task when needed — no pipeline, no segments, no advisory locks. Implementations that support compaction satisfy both `DocumentStore` and `DocumentCompactor`.

See `_docs/future/ideas/performance/yjs-periodic-compaction.md` for trigger thresholds and open questions.

## Producer Identity and Provenance

- `thread_id` is required execution context.
- `turn_id` links creation to one turn/tool event.
- `agent_run_id` is required for run-level traceability.
- `producer_agent_type` is required for filtering and analytics. Values are lowercase snake_case identifiers (e.g., `editing_agent`, `continuity_agent`).
- (`thread_id`, `agent_run_id`, `id`) must trace each AI change end-to-end.
- `turn_id` is nullable. Not all agent operations originate from a specific turn (e.g., background continuity checks).

## Tables Removed (vs Previous Drafts)

| Removed Table | Reason |
|---|---|
| `collab_document_applied_operations` | Yjs handles document state internally — no explicit op log needed |
| `collab_document_leases` | CRDTs are conflict-free — no lease fencing needed |
| `collab_document_state` | Replaced by `collab_document_snapshots` table — snapshots tracked separately, not on documents row |
| `collab_document_compacted_segments` | No compaction pipeline — periodic snapshots replace this |
| `collab_document_proposal_rollups` | Proposals retained indefinitely — no rollups or cleanup needed |
| `collab_ws_tickets` | JWT-in-first-message auth eliminates ticket table |

## Related

- `_docs/plans/fb-realtime-collab-editing.md`
- `_docs/plans/collab-ai/spec/api-events-contract.md`
- `_docs/plans/collab-ai/spec/compaction-retention.md`
