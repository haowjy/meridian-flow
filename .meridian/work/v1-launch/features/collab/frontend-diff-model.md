---
detail: standard
audience: developer, architect
---
# Frontend Diff Model

## Overview

The frontend derives diff hunks by comparing canonical text with an ephemeral projection. The projection is per-user: only pending proposals where `created_by_user_id = current_user` are applied. Hunks are grouped text regions — the writer acts on what they see, not on individual proposals.

The projection computation itself is shared logic (frontend for diff UI, backend for AI context). This spec covers the frontend-specific diff and rendering pipeline on top of it.

## Derivation Pipeline

Two passes: one combined projection for the diff, then per-proposal clones for attribution.

```mermaid
flowchart TB
    subgraph pass1 ["Pass 1: Combined Diff"]
        A["Canonical Y.Doc"] --> B["Clone"]
        B --> C["Apply current-user pending<br/>proposal yjs_updates<br/>(skip stale)"]
        C --> D["Text diff:<br/>canonical vs projection"]
        D --> E["Raw hunks with<br/>canonical ranges"]
    end
    subgraph pass2 ["Pass 2: Attribution"]
        F["For each current-user<br/>pending proposal"] --> G["Clone canonical"]
        G --> H["Apply single<br/>proposal yjs_update"]
        H --> I["Text diff:<br/>canonical vs single clone"]
        I --> J["Per-proposal<br/>affected ranges"]
    end
    E --> K["Map per-proposal ranges<br/>into combined hunks"]
    J --> K
    K --> L["Group overlapping hunks"]
    L --> M["Projection GC:<br/>no-diff proposals → stale"]
    M --> N["CM6 decorations"]
    N --> O["Destroy all clones"]
```

Full re-derive triggers: `_proposal_status` map change or proposal-set change. Local typing does not trigger re-derive immediately — CM6 decoration `map()` shifts hunk positions. A debounced 500ms re-derive runs after typing pauses to catch staleness. Remote canonical text changes trigger immediate re-derive.

### How Yjs Handles Overlapping Updates

When two proposals edit the same text region, Yjs CRDT composition (YATA algorithm) merges them automatically via left/right origin references. Applying both yjs_updates to a clone produces one merged result — the text diff shows one hunk naturally.

| Case | Yjs behavior | Grouping needed? |
|------|-------------|-----------------|
| Overlapping (same region) | CRDT composition → one merged result | No — one hunk naturally |
| Adjacent (nearby lines) | Separate text changes | Only if they share a proposal (proposal atomicity rule) |
| Distant (far apart) | Separate text changes | No — separate hunks |

### Attribution Algorithm

Yjs has no built-in API for "which update changed which text region." We compute this by cloning canonical once per pending proposal, applying each individually, and diffing:

Clone procedure (Yjs has no public `Y.Doc.clone()`):
```typescript
function cloneDoc(source: Y.Doc): Y.Doc {
  const clone = new Y.Doc(); // gc: true by default — acceptable for projection
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(source));
  return clone;
}
// Note: clone uses gc: true (default). Tombstones from canonical are GC'd on apply.
// Safe for projection: we only extract text and destroy the clone immediately.
// Canonical Y.Doc must always remain gc: false (tombstones needed for UndoManager).
```

```
Pass 1 — combined diff:
  projection = cloneDoc(canonical)
  for each current-user pending P (not stale per pre-check):
    applyUpdate(projection, P.yjs_update)
  combinedHunks = textDiff(canonical.text, projection.text)

Pass 2 — per-proposal attribution:
  for each current-user pending P:
    solo = clone(canonical)
    applyUpdate(solo, P.yjs_update)
    P.regions = textDiff(canonical.text, solo.text)

  for each combinedHunk:
    hunk.proposals = [P for P where P.regions overlaps hunk.range]
```

This correctly attributes even when proposals interact:

```
P1: insert "black " before "cat"   → solo diff: insert at pos 4
P2: insert "big " before "cat"     → solo diff: insert at pos 4
Combined (CRDT ordering):          → "big black cat" (one hunk at pos 4)
Both P1.regions and P2.regions overlap → hunk carries [P1, P2]
```

## Grouped Hunk Identity

Each hunk represents one visible region that may include one or more proposals. The writer acts on regions, not on proposal rows.

### Grouping Algorithm

Two rules, applied via transitive closure:

1. **Proposal atomicity**: Hunks that share any contributing proposal must be in the same group. A proposal's `yjs_update` is atomic -- you can't partially apply it.
2. **Overlapping ranges**: Hunks whose text ranges overlap merge into one group.

Both rules are transitive: if hunk A overlaps B and B shares a proposal with C, all three merge.

```mermaid
flowchart TB
    A["Raw hunks with<br/>proposal attribution"] --> B["Merge hunks sharing<br/>any proposal ID"]
    B --> C["Merge hunks with<br/>overlapping text ranges"]
    C --> D["Final grouped hunks<br/>with proposal sets"]
```

No paragraph-level heuristic. If two edits don't overlap and don't share a proposal, the writer can accept/reject each independently -- even within the same paragraph.

### Example: Non-Overlapping Edits Stay Separate

```
Canonical: "She walked to the store and bought some milk."

Three separate proposals:
  P1: "walked" → "ran"
  P2: "store" → "market"
  P3: "milk" → "oat milk"

No overlapping ranges, no shared proposals → three independent hunks.
Writer acts on each one separately.
```

### Example: Overlapping Edits Merge

```
Canonical: "The cat sat on the mat."

P1: "cat sat" → "cat lazily sat"    (insert "lazily ")
P2: "cat sat" → "cat quietly sat"   (insert "quietly ")

CRDT composition → "cat quietly lazily sat" (one combined hunk)
Both P1 and P2 attributed → grouped hunk [P1, P2].
```

### Example: Multi-Paragraph Proposal

```
Canonical:
  "The sun set behind the hills.\n\nShe turned and walked home."

P1 rewrites both paragraphs (one edit_document call):
  "The sun dipped below the ridge.\n\nShe turned and ran home."

Raw hunks span two paragraphs, but both carry [P1] → one grouped hunk.
Writer accepts or rejects the entire edit.
```

If the writer wants finer-grained control over multi-paragraph edits, the AI should produce smaller proposals. That's a prompt/tool concern, not a diff model concern.

## Projection GC and Stale Proposals

Stale detection uses a **text pre-check** before applying to the projection clone:

1. For each pending proposal, compare `region_text_before` against canonical text at `proposed_at_offset`.
2. If canonical already contains `region_text_after` at that position, the proposal is stale — skip it entirely (do not apply its `yjs_update` to the clone).
3. Mark stale proposals with `ORIGIN_GC` (not tracked by UndoManager).

**Why not apply-then-diff?** Yjs idempotence only applies to the *same update bytes* (same struct IDs). Independently-created semantically equivalent edits (different Yjs client IDs) would produce duplicate content in the clone, not a no-op. The text pre-check avoids this.

Additionally, after Pass 2 attribution, any pending proposal whose solo diff produces empty regions (no text change vs canonical) is marked `stale` via `ORIGIN_GC`. This catches proposals whose changes landed in canonical through other means (e.g., an overlapping proposal was accepted that included the same text change).

**Unstale: stale is non-terminal.** On every re-derive, previously-stale proposals are re-evaluated. If the stale pre-check no longer passes (canonical no longer contains `region_text_after` at the position — e.g., because the accept that caused staleness was Ctrl-Z'd or a restore rolled back canonical), the proposal's `_proposal_status` entry is deleted via `ORIGIN_GC` (returning it to `pending`). The proposal re-enters the projection and renders as a hunk again.

Stale proposals are never rendered as hunks. Thread UI shows stale proposals as "No longer relevant" while stale, and returns to normal pending/hunk display if the proposal becomes unstale.

## Hunk Actions

| User action | Canonical/map mutation | Next derive result |
|-------------|------------------------|--------------------|
| Accept hunk | Apply all hunk proposal updates + set each proposal status `accepted` in one transaction | Hunk disappears (canonical catches up) |
| Reject hunk | Set each hunk proposal status `rejected` in one transaction | Hunk disappears (pending set shrinks) |
| Edit hunk | Reject then type, or accept then modify (`ORIGIN_HUMAN`) | Hunk disappears or reshapes around new canonical text |
| Undo accept hunk | Revert full transaction | Entire hunk reappears as one undo step |
| Undo reject hunk | Revert full transaction | Entire hunk reappears as one undo step |

**Freshness guard:** Before executing Accept/Reject, check that the hunk's derivation sequence number matches the current derivation. If canonical text or proposal set changed since the hunk was rendered (e.g., user typed near the hunk or a remote edit landed during the 500ms debounce window), force a synchronous re-derive before committing. See Local-First Authority (not yet documented separately) — Hunk Action Freshness.

## CM6 Rendering

Hunk rendering remains decoration-based:

- Deletions: mark decorations on canonical ranges.
- Insertions: widget decorations for inserted text.
- Replacements: deletion mark + insertion widget.
- Action controls: Accept / Reject / Edit widgets bound to grouped hunk region data.

## Performance

| Workload | Expected cost |
|----------|---------------|
| Pass 1: clone + apply all updates | ~2ms |
| Pass 1: text diff (~2000 words) | ~3-10ms |
| Pass 2: N solo clones + diffs (attribution) | ~2-5ms per proposal |
| Group + decorate | ~1-3ms |
| Total derive cycle (5 pending proposals) | ~20-35ms |

With 5 pending proposals, the attribution pass dominates. This is acceptable -- the pipeline runs on proposal events and debounced typing pauses, not every keystroke. If proposal counts grow large, the solo-clone pass can be optimized by caching per-proposal diffs and only recomputing changed proposals.

**Scaling note:** The pipeline is O(P × N) where P = pending proposals and N = document size. For the target workload (individual chapters of ~5-20k words, not entire 100+ chapter serials), this is well within budget. Each chapter is a separate document with its own projection. If a single chapter accumulates >20 pending proposals, consider incremental diff (only recompute changed proposals' solo diffs, reuse cached results for unchanged ones).

### Re-Derive Strategy

The full clone/apply/diff pipeline runs on **proposal events** and **debounced typing pauses**, not on every keystroke:

| Trigger | Action |
|---------|--------|
| New proposal arrives | Full re-derive |
| Proposal status changes (accept/reject/stale) | Full re-derive |
| Local typing (canonical text change, no proposal change) | CM6 decoration `map()` shifts hunk positions — no re-derive |
| Local typing pause (500ms debounce) | Full re-derive — catches staleness from user edits |
| Remote canonical text change (other user's accept, thread undo, auto-apply) | Immediate full re-derive — remote edits can change hunk grouping and staleness |

CM6 decorations automatically remap their positions when the document changes via `map()`. User typing shifts existing hunk positions without recomputing the diff. The expensive pipeline runs when the set of pending proposals or their statuses change, or after a 500ms typing pause (to catch staleness from user edits near pending hunks).

If proposal events arrive in bursts (e.g., AI streaming multiple `edit_document` calls), debounce re-derive by 50-100ms. Decoration updates lagging by one frame are invisible to the writer. When no proposals are pending, the pipeline is skipped entirely.

## Cross-References

- Architecture -- not yet documented separately; see [foundations/domain-architecture.md](../../foundations/domain-architecture.md)
- Local-First Authority -- not yet documented separately
- [Undo Design](undo.md)
- Schema Design -- not yet documented separately (proposal columns used in projection)
- Implementation Plan -- see [plan/implementation-plan.md](../../plan/implementation-plan.md)
