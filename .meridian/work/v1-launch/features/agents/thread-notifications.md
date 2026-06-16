# Thread Notifications

Generic primitive for delivering messages to a thread. All system-initiated notifications flow through `ThreadNotifier` -- background task completion, tool approvals, system events, inter-thread communication.

## `internal` Turn Role

New role for system-initiated turns. Meridian storage concept only -- no provider supports arbitrary roles. All providers receive `internal` translated to `user` with prefix (e.g., `[System notification]: ...`). Translation happens in `MessageBuilder` before the provider adapter.

```sql
ALTER TABLE ${TABLE_PREFIX}turns
  DROP CONSTRAINT IF EXISTS ${TABLE_PREFIX}turns_role_check,
  ADD CONSTRAINT ${TABLE_PREFIX}turns_role_check
    CHECK (role IN ('user', 'assistant', 'internal'));
```

**Pipeline changes**: Extend `CreateTurnRequest`, `MessageBuilder`, and turn validation to accept `internal`.

## ThreadNotifier

```go
type ThreadNotification struct {
    ThreadID string
    Source   string                 // "background_task", "tool_approval", "system", "webhook", "thread"
    Content  string                 // what to tell the LLM
    Metadata map[string]interface{} // structured data
}

type ThreadNotifier interface {
    Notify(ctx context.Context, n *ThreadNotification) error
}
```

### Behavior by Thread State

| Thread state | Notifier behavior |
|-------------|-------------------|
| **Idle** | Create `internal` turn, trigger new assistant turn (auto-wake) |
| **Mid-stream** | Queue as pending context, picked up on next tool round |

### Client Notification

ThreadNotifier also sends a WebSocket event on the project channel:

```json
{"type": "thread_activity", "thread_id": "...", "source": "background_task"}
```

| Client state | Behavior |
|-------------|----------|
| Thread open in UI | Reconnect SSE, see new streaming response |
| Thread not open | Show badge / toast |
| No client connected | LLM still runs, user sees result when they open the thread |

### Use Cases

| Source | Example |
|--------|---------|
| `background_task` | "Continuity checker finished: found 3 issues" |
| `tool_approval` | "User approved file write to chapter-42.md" |
| `system` | "Approaching context limit, consider compacting" |
| `admin` | "Context compacted by system" |
| `webhook` | "Export job completed" |
| `thread` | "Reviewer thread flagged an issue" |

ThreadNotifier doesn't care about the source. It delivers the message and handles idle vs mid-stream. Each caller constructs its own `ThreadNotification`.
