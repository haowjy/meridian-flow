# Phase 4: Turn Status Rendering

## Scope
Render all backend turn statuses correctly in the UI. This phase is purely visual — it consumes the TurnStatus from Phase 1's ThreadTurn type and renders appropriate UI for each state.

**Requires Phase 1** — TurnStatus and related metadata must be in the data model first.

## Files to Create
- `frontend-v2/src/features/threads/components/TurnStatusBanner.tsx` — Status banners for error/cancelled/credit_limited
- `frontend-v2/src/features/threads/components/PendingTurn.tsx` — Pending/loading turn indicator
- `frontend-v2/src/features/activity-stream/examples/status-scenarios.ts` — Mock ThreadTurn data for each status

## Files to Modify
- `frontend-v2/src/features/threads/components/TurnRow.tsx` — Route to status-specific rendering
- `frontend-v2/src/features/activity-stream/ActivityBlockHeader.tsx` — Status-aware header badge for waiting_subagents

## Status Routing
TurnRow (from Phase 2) becomes the status router. ActivityBlock itself stays focused on rendering activity items — it doesn't need to know about turn-level status.

```tsx
function TurnRow({ turn }: { turn: ThreadTurn }) {
  // Status-first routing
  if (turn.status === "pending") return <PendingTurn />
  if (turn.status === "error") return <ErrorTurn turn={turn} />
  if (turn.status === "cancelled") return <CancelledTurn turn={turn} />
  if (turn.status === "credit_limited") return <CreditLimitedTurn turn={turn} />

  // Normal rendering (streaming, complete, waiting_subagents)
  return (
    <>
      {turn.siblingIds.length > 1 && <SiblingNav ... />}
      {turn.role === "user"
        ? <UserBubble turn={turn} />
        : <ActivityBlock activity={turn.activity} />
      }
    </>
  )
}
```

## Status Visual Design

| Status | Visual Treatment |
|--------|-----------------|
| `pending` | Three-dot pulse animation, muted text "Thinking..." |
| `streaming` | Existing: animated header + live content (no change) |
| `waiting_subagents` | ActivityBlock header shows "Waiting for agents..." + spinner. Card stays expanded showing completed tool calls so far. |
| `complete` | Existing: collapsed card + response text below (no change) |
| `cancelled` | Muted ActivityBlock (reduced opacity) + "Cancelled" badge. Partial content preserved — blocks with `status: "partial"` still render. |
| `error` | Error banner above any partial content: destructive border, error message from `turn.error`. |
| `credit_limited` | Warning banner (amber) "Credit limit reached" above partial content. |

### Error Banner
```tsx
function TurnStatusBanner({ variant, message }: { variant: "error" | "warning"; message: string }) {
  return (
    <div className={cn(
      "rounded-lg border px-4 py-3",
      variant === "error" && "border-destructive/30 bg-destructive/5 text-destructive",
      variant === "warning" && "border-warning/30 bg-warning/5 text-warning",
    )}>
      <p className="text-sm">{message}</p>
    </div>
  )
}
```

### Cancelled/Error/CreditLimited Turns
These render partial content (whatever tools/text completed before interruption) with a status banner above:

```tsx
function CancelledTurn({ turn }: { turn: ThreadTurn }) {
  return (
    <div className="opacity-70">
      <TurnStatusBanner variant="warning" message="This response was cancelled." />
      {turn.activity && <ActivityBlock activity={turn.activity} />}
    </div>
  )
}
```

## Dependencies
- Requires: Phase 1 (TurnStatus on ThreadTurn)
- Requires: Phase 2 (TurnRow component to modify)
- Independent of: Phases 3, 5

## Verification Criteria
- [ ] Each of 7 statuses has a distinct, recognizable visual
- [ ] Error message from backend displays in error banner
- [ ] Cancelled turns show partial content with muted styling
- [ ] Credit limited shows warning banner with partial content
- [ ] Pending state shows loading indicator (not empty space)
- [ ] waiting_subagents shows spinner in ActivityBlock header
- [ ] Stories exist for each status variant using mock ThreadTurn data
- [ ] ActivityBlock itself is unchanged — status routing lives in TurnRow
