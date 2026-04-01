# Research: Drain-Race Coordination Patterns for Interjection Stream Switch

Date: 2026-03-29

## Local code path analyzed

- `backend/internal/service/llm/streaming/tool_executor.go`: interjection point A drains with `DrainAndClear()`, then calls `SwitchStream(...)`.
- `backend/internal/service/llm/streaming/completion_handler.go`: interjection point B does the same at no-tools completion.
- `backend/internal/service/llm/streaming/stream_runtime.go`: old executor/interjection buffer cleanup occurs in executor termination callback (`interjectionRegistry.Remove(turnID)`).
- `meridian-stream-go/interjection.go`: buffer is independent from stream-switch lifecycle and has no transition phase.

Observed race window: after `DrainAndClear` and before old executor cleanup + new turn publication, writers can still append to old buffer and those writes are dropped when old buffer is removed.

## External patterns (what production systems do)

### 1) Drain/handoff in message systems

- **Kafka consumer groups** fence stale members with generation semantics.
  - Offset commits from a consumer no longer in the active group fail (`CommitFailedException`, `ILLEGAL_GENERATION`), forcing caller to rejoin rather than silently accept stale writes.
  - Cooperative rebalancing is multi-phase: partitions are revoked first, then reassigned in a follow-up rebalance, explicitly modeling transition windows.
- **RabbitMQ** prioritizes no-loss by requeueing unacked messages when consumer/channel/connection fails; this is at-least-once (duplicates expected). Single Active Consumer (SAC) transitions can wait for outstanding acks before switching active consumer.
- **Redis Streams consumer groups** keep unacked entries in PEL and support claiming by another consumer (`XCLAIM`/`XAUTOCLAIM`) rather than dropping work. Caveat: trimming/deletion before ack can remove payload while still in PEL.

Implication for Meridian: handoff windows are made explicit; stale writers are rejected or redirected, and in-flight items are recoverable (not silently dropped).

### 2) State transition coordination patterns

- **Two-phase commit (2PC)**: strongest atomicity model, but high complexity and can block around prepare/commit.
- **Fencing tokens / generation counters**: lightweight and robust for stale-writer rejection. Writers include/read epoch; stale epoch writes are rejected or retried.
- **Redirect map / aliasing**: old ID maps to new owner during and after handoff; old writers are forwarded until clients converge.
- **ZooKeeper recipes** show ordered sequence IDs + watches to avoid herd effects and explicit two-phase commit recipe; key lesson is explicit ordered transitions and idempotent recovery.

### 3) Go concurrency guidance relevant here

- Keep mutex critical sections short and never hold locks across DB/network I/O.
- Use mutexes for state transitions, atomics for hot-path state reads/fencing where needed.
- Channel-actor ownership can avoid shared-memory races, but introduces goroutine/mailbox lifecycle overhead.

## Evaluation of proposed `InterjectionForwarder` (`idle -> draining -> forwarded(newTurnID)`)

### Verdict

Good direction and aligns with Kafka/RabbitMQ/Redis handoff semantics, **but incomplete unless `draining` has defined writer behavior**.

### Required guarantees

1. `draining` must not silently drop writes.
2. Writers must get deterministic outcome: queued in pending buffer, redirected, or explicit retry error.
3. Transition should be fenced (epoch/generation) so stale transition completions cannot overwrite newer state.
4. Switch failure needs rollback semantics (`draining -> idle`) with pending replay.

## Recommended design (minimal robust)

Add per-turn forward entry with pending buffer and epoch:

- `idle`: writes append to `activeBuffer`.
- `draining(epoch++)`: handoff in progress; writes append to `pendingBuffer` (no I/O, short lock only).
- `forwarded(newTurnID, epoch)`: writes redirect to `newTurnID` (optionally path-compress alias chain).
- optional `closed`: old mapping can be garbage-collected after TTL.

### Transition algorithm

1. `BeginDrain(oldTurnID)`
   - lock entry, set `draining`, bump epoch, `drain = active.DrainAndClear()`, unlock.
2. Perform `SwitchStream` I/O (DB + launch) outside lock.
3. On success: `PublishForward(oldTurnID, newTurnID, epoch)`
   - lock, verify epoch matches, set forwarded target, drain pending and append/merge into new turn buffer, unlock.
4. On failure: `RollbackDrain(oldTurnID, epoch)`
   - lock, verify epoch, move pending back to active, set `idle`, unlock.

This avoids holding locks across I/O and closes the data-loss window.

## Go sketch

```go
type phase uint8
const (
    phaseIdle phase = iota
    phaseDraining
    phaseForwarded
)

type interjectionEntry struct {
    mu      sync.Mutex
    phase   phase
    epoch   uint64
    target  string // valid in forwarded
    active  *rstream.InMemoryInterjectionBuffer
    pending *rstream.InMemoryInterjectionBuffer
}

func (e *interjectionEntry) Append(content string) (redirect string, err error) {
    e.mu.Lock()
    defer e.mu.Unlock()

    switch e.phase {
    case phaseIdle:
        return "", e.active.Append(content)
    case phaseDraining:
        // queue during handoff; no loss, no blocking on switch I/O
        return "", e.pending.Append(content)
    case phaseForwarded:
        return e.target, nil
    default:
        return "", fmt.Errorf("invalid phase")
    }
}

func (e *interjectionEntry) BeginDrain() (epoch uint64, drained string, ok bool) {
    e.mu.Lock()
    defer e.mu.Unlock()

    if e.phase != phaseIdle {
        return 0, "", false
    }
    e.phase = phaseDraining
    e.epoch++
    drained, ok = e.active.DrainAndClear()
    return e.epoch, drained, ok
}

func (e *interjectionEntry) PublishForward(epoch uint64, newTurnID string) (late string, ok bool) {
    e.mu.Lock()
    defer e.mu.Unlock()

    if e.phase != phaseDraining || e.epoch != epoch {
        return "", false // stale completion fenced out
    }
    e.phase = phaseForwarded
    e.target = newTurnID
    late, _ = e.pending.DrainAndClear()
    return late, true
}

func (e *interjectionEntry) Rollback(epoch uint64) bool {
    e.mu.Lock()
    defer e.mu.Unlock()

    if e.phase != phaseDraining || e.epoch != epoch {
        return false
    }
    if late, ok := e.pending.DrainAndClear(); ok {
        _ = e.active.Append(late)
    }
    e.phase = phaseIdle
    return true
}
```

## Alternative options

1. **Simpler but less UX-friendly**: during `draining`, return `409 transition_in_progress` with `retry_turn_id` when known. No pending buffer.
2. **Most robust (heavier)**: durable interjection log table (outbox style) with consumed cursor per turn switch; no memory-loss on process crash.
3. **Actor model**: one goroutine owns interjection state per active turn; excellent race safety, higher lifecycle complexity.

## Recommendation

Implement the forwarder with `pending + epoch fencing` now (lowest complexity that fully closes the race). Add a focused concurrency test that schedules writes:

- before `BeginDrain`
- during `draining` before `PublishForward`
- after `forwarded`

and asserts all writes are present exactly once in either switched user turn content or redirected target buffer.

## Sources

- Kafka `CommitFailedException` javadoc: https://kafka.apache.org/21/javadoc/org/apache/kafka/clients/consumer/CommitFailedException.html
- Kafka protocol errors (`ILLEGAL_GENERATION`): https://kafka.apache.org/24/design/protocol/
- Kafka cooperative rebalance semantics: https://kafka.apache.org/24/getting-started/upgrade/
- Kafka leader/epoch redirect optimization (KIP-951): https://cwiki.apache.org/confluence/display/KAFKA/KIP-951%3A%2BLeader%2Bdiscovery%2Boptimizations%2Bfor%2Bthe%2Bclient
- RabbitMQ Consumers (SAC semantics): https://www.rabbitmq.com/docs/4.1/consumers
- RabbitMQ reliability guide: https://www.rabbitmq.com/docs/reliability
- RabbitMQ consumer cancel notification: https://blog.rabbitmq.com/docs/4.1/consumer-cancel
- Redis Streams commands (`XREADGROUP`, `XACK`, `XCLAIM`, `XAUTOCLAIM`): https://redis.io/docs/latest/develop/data-types/streams/
- Redis Streams `XAUTOCLAIM`: https://redis.io/docs/latest/commands/xautoclaim/
- PostgreSQL 2PC overview: https://www.postgresql.org/docs/16/two-phase.html
- ZooKeeper recipes (locks, 2PC, leader election): https://zookeeper.apache.org/doc/r3.5.0-alpha/recipes.pdf
- Go `sync` package docs: https://pkg.go.dev/sync
- Go context pattern: https://go.dev/blog/context
