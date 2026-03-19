# Phase 2b: Frontend Projection + Diff Pipeline

## Scope and Intent

Frontend half of the projection pipeline. Implement the core derivation algorithm: clone canonical, apply pending proposals, diff, attribute, group into hunks, detect stale, render CM6 decorations. This is built in `toy/frontend.html` and a dev-only CM6 route — not in the production frontend.

This phase runs **in parallel** with Phase 2a (backend validation). Both must pass golden parity tests before the round commits.

## Dependencies

- **Requires:** Phase 1 complete (proposal columns present)
- **Parallel with:** Phase 2a (backend validation + BuildProjectedState)

## Files to Modify/Create

| File | Change |
|------|--------|
| `toy/frontend.html` | Extend existing toy with full projection pipeline: Pass 1 (combined diff), Pass 2 (attribution), grouping, stale detection (including unstale), GC |
| `toy/yjs-spec-tests.mjs` | Add projection pipeline tests, parity test data generation |
| New: dev CM6 route files (location TBD) | Bare `EditorView` + `y-codemirror.next` + projection/diff pipeline + CM6 decorations |

## Algorithm Reference

See [Frontend Diff Model](../spec/frontend-diff-model.md) for the full pipeline. Key steps:

### Pass 1: Combined Diff
```
projection = cloneDoc(canonical)
for each current-user pending P (not stale per pre-check):
    applyUpdate(projection, P.yjs_update)
combinedHunks = textDiff(canonical.text, projection.text)
```

### Pass 2: Attribution
```
for each current-user pending P:
    solo = cloneDoc(canonical)
    applyUpdate(solo, P.yjs_update)
    P.regions = textDiff(canonical.text, solo.text)

for each combinedHunk:
    hunk.proposals = [P for P where P.regions overlaps hunk.range]
```

### Grouping (transitive closure)
1. Merge hunks sharing any proposal ID (proposal atomicity)
2. Merge hunks with overlapping text ranges
3. Both rules are transitive

### Stale Detection (non-terminal)
- **Pre-check:** If canonical contains `region_text_after` at `proposed_at_offset`, skip in projection, mark `stale` via `ORIGIN_GC`
- **Empty attribution catch:** After Pass 2, if a proposal's solo diff is empty, mark `stale`
- **Unstale:** On every re-derive, if a previously-stale proposal's pre-check no longer passes, delete its Y.Map entry via `ORIGIN_GC` (returns to pending)

### Re-derive Triggers
| Trigger | Action |
|---------|--------|
| New proposal arrives | Full re-derive |
| Proposal status changes | Full re-derive |
| Local typing | CM6 `map()` shifts decorations, no re-derive |
| Local typing pause (500ms) | Full re-derive |
| Remote canonical change | Immediate full re-derive |

## Key Implementation Notes

### Clone procedure
```typescript
function cloneDoc(source: Y.Doc): Y.Doc {
    const clone = new Y.Doc();  // gc: true by default
    Y.applyUpdate(clone, Y.encodeStateAsUpdate(source));
    return clone;
}
```

### Hunk data structure
```typescript
interface GroupedHunk {
    proposals: { id: string; yjs_update: Uint8Array }[];
    canonicalRange: { from: number; to: number };
    insertedText: string;
    deletedText: string;
    sequenceNumber: number;  // for freshness guard
}

interface DeriveResult {
    hunks: GroupedHunk[];
    sequenceNumber: number;
}
```

### CM6 Decorations
- Deletions: `Decoration.mark()` on canonical ranges (strikethrough/red)
- Insertions: `Decoration.widget()` for inserted text (green)
- Replacements: deletion mark + insertion widget
- Action controls: Accept/Reject widgets bound to grouped hunk data

### Performance budget
- Total derive cycle (5 pending proposals): ~20-35ms
- Debounce proposal event bursts: 50-100ms

## Verification Criteria

- [ ] `toy/frontend.html` demonstrates full projection pipeline end-to-end
- [ ] Pass 1 (combined diff) produces correct canonical vs projection diff
- [ ] Pass 2 (attribution) correctly maps proposals to combined hunks
- [ ] Overlapping proposals merge into one grouped hunk
- [ ] Non-overlapping proposals from same turn stay separate
- [ ] Multi-paragraph proposals with same proposal ID merge (atomicity rule)
- [ ] Stale detection: proposal matching canonical text at `proposed_at_offset` is marked stale
- [ ] Unstale: previously-stale proposal returns to pending when canonical rolls back
- [ ] Empty-attribution catch: proposal with no solo diff is marked stale
- [ ] `ORIGIN_GC` is not tracked by UndoManager (stale writes are invisible to undo)
- [ ] CM6 dev route renders hunks with deletion marks and insertion widgets
- [ ] Dev route debounces re-derive on typing (500ms)
- [ ] Dev route triggers immediate re-derive on proposal events
- [ ] Golden parity test data matches Phase 2a backend output
