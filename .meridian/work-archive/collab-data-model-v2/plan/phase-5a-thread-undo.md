# Phase 5a: Thread-Level Undo/Reapply

## Scope and Intent

Implement thread-level undo (revert an accepted proposal days later), reapply (re-accept a reverted/rejected proposal), and Undo All. These are frontend-only Yjs transactions using offset-anchored text search. Thread UI renders proposal status as overlays on tool calls — no thread message mutation.

## Dependencies

- **Requires:** Phase 4 complete (status mirror live, proposal rows reflect Y.Map state)
- **Parallel with:** Phase 5b (turn-level restore)

## Files to Modify/Create

| File | Change |
|------|--------|
| `toy/frontend.html` | Add thread undo/reapply/undo-all demonstrations |
| Dev CM6 route | Add thread UI sidebar with status overlays and undo/reapply buttons |
| New: frontend thread undo module | Offset-anchored search, `ORIGIN_THREAD` transactions |

## Algorithm Reference

See [Undo Design](../spec/undo.md) — Thread-Level Undo.

### Offset-Anchored Search

```typescript
function findNearOffset(text: string, target: string, offset: number, tolerance: number = 500): number {
    const windowStart = Math.max(0, offset - tolerance);
    const windowEnd = Math.min(text.length, offset + tolerance + target.length);
    const window = text.substring(windowStart, windowEnd);

    let bestPos = -1;
    let bestDist = Infinity;
    let searchStart = 0;

    while (true) {
        const idx = window.indexOf(target, searchStart);
        if (idx === -1) break;
        const absolutePos = windowStart + idx;
        const dist = Math.abs(absolutePos - offset);
        if (dist < bestDist) {
            bestDist = dist;
            bestPos = absolutePos;
        }
        searchStart = idx + 1;
    }

    return bestPos;  // -1 if not found within tolerance
}
```

### Thread Undo (`accepted → reverted`)

```typescript
function threadUndo(doc: Y.Doc, proposal: Proposal): ThreadUndoResult {
    const text = doc.getText('content');
    const canonical = text.toString();
    const pos = findNearOffset(canonical, proposal.region_text_after, proposal.accepted_at_offset);

    if (pos === -1) return { success: false, conflict: 'text was edited' };

    undoManager.stopCapturing();
    doc.transact(() => {
        text.delete(pos, proposal.region_text_after.length);
        text.insert(pos, proposal.region_text_before);
        doc.getMap('_proposal_status').set(proposal.id, 'reverted');
    }, ORIGIN_THREAD);

    return { success: true };
}
```

### Thread Reapply (`reverted/rejected → accepted`)

```typescript
function threadReapply(doc: Y.Doc, proposal: Proposal): ThreadUndoResult {
    const text = doc.getText('content');
    const canonical = text.toString();
    // Use accepted_at_offset for reverted, proposed_at_offset for rejected
    const offset = proposal.status === 'reverted'
        ? proposal.accepted_at_offset
        : proposal.proposed_at_offset;
    const pos = findNearOffset(canonical, proposal.region_text_before, offset);

    if (pos === -1) return { success: false, conflict: 'text was edited' };

    undoManager.stopCapturing();
    doc.transact(() => {
        text.delete(pos, proposal.region_text_before.length);
        text.insert(pos, proposal.region_text_after);
        doc.getMap('_proposal_status').set(proposal.id, 'accepted');
    }, ORIGIN_THREAD);

    // Persist new accepted_at_offset
    api.setAcceptedAtOffset(proposal.id, pos, proposal.offset_version + 1);

    return { success: true };
}
```

### Undo All

Iterate accepted proposals in thread in **reverse chronological order** (newest first). Each is an independent thread undo attempt. Return per-proposal results.

```typescript
function undoAll(doc: Y.Doc, proposals: Proposal[]): Map<string, ThreadUndoResult> {
    const sorted = proposals
        .filter(p => p.status === 'accepted')
        .sort((a, b) => b.created_at - a.created_at);  // newest first

    const results = new Map();
    for (const proposal of sorted) {
        results.set(proposal.id, threadUndo(doc, proposal));
    }
    return results;
}
```

## Thread UI

### Status Overlay on Tool Calls

Thread messages are immutable. The overlay is derived from proposal row status:

```
status: accepted   →  [Accepted] [Undo]
status: rejected   →  [Rejected] [Reapply]
status: reverted   →  [Reverted] [Reapply]
status: stale      →  "No longer relevant"
status: pending    →  "Pending review" (visible as diff hunk in editor)
```

### Turn-Level Controls

```
[Undo All Accepted]              — iterates per-proposal undo
[Restore to before this turn]    — only shown while ai_turn bookmark exists (Phase 5b)
```

### Conflict Display

```
[Undo failed — text was edited]  — transient UI state, not persisted
```

## Key Implementation Notes

- `ORIGIN_THREAD` is tracked by UndoManager — thread ops enter the session undo stack and are Ctrl-Z-able
- Thread undo + Ctrl-Z compose: Ctrl-Z of a thread undo restores `accepted` status
- Thread ops write to both `Y.Text` and `Y.Map` in one transaction
- After reapply, persist new `accepted_at_offset` via the offset API endpoint (Phase 1)

## Verification Criteria

- [ ] Thread undo (`accepted → reverted`) via offset-anchored text search works
- [ ] Thread reapply (`reverted → accepted`) via offset-anchored text search works
- [ ] Thread reapply (`rejected → accepted`) uses `proposed_at_offset` as anchor
- [ ] ±500 char tolerance window finds shifted text
- [ ] Multiple matches within window → picks closest to stored offset
- [ ] No match within window → returns conflict (no full-document fallback)
- [ ] Undo All iterates in reverse chronological order
- [ ] Undo All returns per-proposal results (some succeed, some conflict)
- [ ] `ORIGIN_THREAD` transactions enter the session undo stack
- [ ] Ctrl-Z reverses a thread undo (`reverted → accepted`)
- [ ] Thread UI shows correct status overlays on tool calls
- [ ] Thread UI does not modify thread messages (immutable history)
- [ ] `accepted_at_offset` is persisted via REST after reapply
