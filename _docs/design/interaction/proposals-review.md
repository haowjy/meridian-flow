# Proposals & Review

How the writer reviews, accepts, and rejects assistant-proposed changes to
documents. This is the core editorial interaction — the assistant proposes,
the writer decides.

---

## Concepts

- **Proposal** — A set of suggested changes to a document, transported via Yjs
  updates. Has a lifecycle: `pending` → `partial` / `accepted` /
  `rejected` / `mixed`.
- **Hunk (review hunk)** — A single contiguous change within a proposal.
  Rendered inline in the editor as decorations. Each hunk can be independently
  acted on.
- **Review action language** — The writer-facing verbs. **Canonical:
  "Keep" / "Edit" / "Discard"** — writer-first language.

### Why "Keep / Edit / Discard"

> **Decision:** Use "Keep" / "Edit" / "Discard" (and "Keep All" / "Discard
> All" for batch operations). Not "Accept" / "Reject."
>
> **Rationale:** The writer is the author making creative choices about their
> text. "Keep" implies ownership — the writer is choosing to keep a suggestion
> as part of their prose. "Accept" implies gatekeeping — a code reviewer
> approving someone else's change. The former matches the product's
> writer-first positioning.
>
> **Rejected:** "Accept / Reject" — code-review jargon that misaligns with
> the writer persona.
>
> **Source:** This matches the current production code's explicit rationale
> in `ProposalReviewToolbar.tsx:3-7` and is recorded in `vocab.md` as
> canonical.

---

## Decoration Layer Ordering

The editor renders multiple independent decoration layers. Their merge order
is formalized to prevent conflicts. **This is the single canonical layer
ordering — all other docs reference this table.**

| Layer | Priority | Source | Content |
|---|---|---|---|
| 0 | Lowest | Lezer | Syntax highlighting (token colors) |
| 1 | — | Live preview ViewPlugins | Heading, emphasis, link, blockquote, list, HR, image, inline code decorations |
| 2 | — | Wiki-link StateField | `[[page]]` decorations: hide syntax, accent-text styling, broken-link detection |
| 3 | — | Block StateFields | Fenced code blocks, mermaid diagrams |
| 4 | — | Proposal StateField | Hunk decorations (insertions, deletions, replacements) |
| 5 | — | Focus-mode StateField | Paragraph dimming: dims non-cursor paragraphs to `muted-foreground` at 40% opacity. Active only when focus mode is on. See `interaction/editor.md` §Focus Mode. |
| 6 | — | Selection | Text selection highlight |
| 7 | Highest | Collab awareness | Remote cursors and selection ranges |

**Overlap rule:** When live-preview decorations (layer 1) and proposal hunks
(layer 4) affect the same line:

> **Decision:** Proposal hunks take visual precedence. Live-preview decorations
> (e.g., hiding `#` from a heading) still apply, but the hunk
> background/strikethrough renders on top.
>
> **Rationale:** During review, seeing exactly what changed matters more than
> seeing the pretty-printed result. The hunk decoration must be unambiguous.
>
> **Implementation note:** CM6's decoration merging respects the `DecorationSet`
> ordering. Layer 4 decorations (hunks) are added after layer 1 (live preview)
> in the extension array, so they take precedence for overlapping ranges.

---

## Inline Hunk Rendering

Each hunk is rendered directly in the editor using CM6 decorations.

### Hunk Types

| Type | Visual | Description |
|---|---|---|
| **Insertion** | Green (`success`) background tint on inserted text | New text added |
| **Deletion** | Red (`destructive`) background tint + strikethrough on deleted text | Text removed |
| **Replacement** | Red strikethrough on old text, green highlight on new text (adjacent) | Text changed |

### Hunk Background Colors

Using the functional tokens at low opacity for subtlety:

| State | Background |
|---|---|
| Insertion (pending) | `success` at 15% opacity |
| Deletion (pending) | `destructive` at 15% opacity |
| Insertion (hover/focus) | `success` at 25% opacity |
| Deletion (hover/focus) | `destructive` at 25% opacity |
| Accepted | `success` at 8% opacity, fading out over 2s |
| Rejected | No decoration (removed immediately) |

### Hunk Action Widget

A floating toolbar per hunk. Appears on hover or keyboard focus.

| Property | Value |
|---|---|
| Position | Floating above the hunk's first line, right-aligned |
| Background | `card` |
| Border | 1px `border`, `radius-md` |
| Shadow | `--elevation-overlay` |
| Padding | `padding-compact` |

**Actions:**

| Button | Label | Icon | Variant | Shortcut |
|---|---|---|---|---|
| Keep | "Keep" | Phosphor `Check` | ghost, `success` text | `Mod+K` when hunk focused |
| Edit | "Edit" | Phosphor `PencilSimple` | ghost | `Mod+E` when hunk focused |
| Discard | "Discard" | Phosphor `X` | ghost, `destructive` text | `Mod+D` when hunk focused |

**"Edit" flow:**
1. Click "Edit" → `ProposalHunkEditDialog` opens (existing component)
2. Dialog prefills with the hunk's `insertedText`
3. Writer modifies the text
4. `Mod+Enter` commits the edit (keeps hunk with modified text)
5. `Escape` cancels

### Hunk Hover/Focus Behavior

- **Mouse hover:** Widget appears after 300ms hover delay. Disappears when
  mouse leaves the hunk and widget.
- **Keyboard focus:** Widget appears when the cursor is inside the hunk.
  Widget stays visible as long as the cursor remains in the hunk.
- **Keyboard navigation:** `Tab` from the editor moves focus to the widget
  buttons. `Escape` returns focus to the editor.

---

## ProposalReviewToolbar

A floating batch-action toolbar for the entire proposal. Appears when any
pending hunks exist in the active document.

| Property | Value |
|---|---|
| Position | Bottom-center of the editor, floating above content |
| Background | `card` |
| Border | 1px `border`, `radius-xl` |
| Shadow | `--elevation-overlay` |
| Padding | `padding-compact padding-default` (vertical / horizontal) |
| Entry animation | Slide up + fade in, `duration-moderate`, `ease-default` |

**Content:**

```
[ Keep All ] [ Discard All ]     ← 1/5 →    Thread: "Ch 12 Revision"
```

| Element | Treatment |
|---|---|
| "Keep All" | Button, `success` variant (green text), ghost |
| "Discard All" | Button, `destructive` variant (red text), ghost |
| Hunk counter | `text-sm`, `muted-foreground`: "1/5" |
| Hunk navigation | Phosphor `CaretLeft` / `CaretRight`, `icon-xs` buttons |
| **Provenance** | `text-xs`, `muted-foreground`: originating thread name + proposal ID. Shows which thread/proposal produced the currently focused hunk. Multiple threads may contribute hunks to the same document — provenance makes this visible. |

**Hunk navigation:**
- `←` / `→` buttons scroll the editor to the previous/next pending hunk
- The counter updates: "2/5", "3/5"
- Keyboard: `Mod+[` / `Mod+]` for previous/next hunk

### Toolbar Visibility

- **Appears** when the active document has at least one pending hunk
- **Disappears** when all hunks are resolved (kept or discarded)
- **Persists** across mode switches (the toolbar is rendered by the editor,
  which stays mounted)

### Review Scope: Document-Scoped

> **Decision:** In Studio, all pending hunks for the active document are
> visible regardless of which thread proposed them. The review toolbar shows
> per-hunk **provenance** (originating thread/proposal). Undo is **document-
> level** — `Mod+Z` in the editor undoes the most recent review action on
> any hunk in this document, regardless of which thread it came from.
>
> **Rationale:** The writer is editing a document, not managing per-thread
> review queues. If three threads propose changes to Chapter 12, the writer
> should see and resolve all of them in one editing session. Provenance in
> the toolbar tells them where each change came from.
>
> **Rejected:** Thread-scoped review (only show hunks from the sidecar's
> active thread). This hides work the writer needs to see and creates
> confusing "where did that change come from?" moments.

---

## Review Flow by Mode

### In Converse

1. Assistant proposes edits → tool block shows `ProposalQuickActions`:
   `[Keep All] [Discard All] [Review]`
2. Clicking "Review":
   - Editor pane expands (if collapsed)
   - Document loads in editor
   - Editor scrolls to first pending hunk
   - `ProposalReviewToolbar` appears
3. Writer reviews hunks individually (keep/edit/discard) or uses batch
   actions
4. Resolution updates the proposal status badge in the thread

### In Studio

1. Proposals arrive in the sidecar (same tool block rendering)
2. Hunks are **always visible** in the editor for the active document —
   from ALL threads, not just the sidecar's active thread
3. `ProposalReviewToolbar` appears when pending hunks exist, showing
   provenance (originating thread) for each hunk
4. Quick actions in the sidecar provide batch "Keep All" / "Discard All"
   without needing the floating toolbar
5. Review is document-scoped: undoing a review action affects the document's
   undo stack, not a per-thread stack

### In Agents

1. Thread detail pane shows proposals with status badges
2. "Review" action → switches to Converse mode with the relevant thread
   active, then triggers the Converse review flow

---

## Touch Review

How proposal review works on Phone and Tablet without a pointer. The review
model (document-scoped, provenance-visible, Keep/Edit/Discard vocabulary)
is identical to desktop. The interaction surface adapts to touch.

*Evidence: mobile-chat-review.md §2 — "the best mobile pattern is a hybrid:
per-change review sheet plus a sticky action bar." Google Docs mobile puts
suggestion review behind an explicit tap, then Accept/Reject. GitHub Mobile
invested in making PR reviews startable on the go.*

### Per-Hunk Bottom Sheet

On Phone, tapping a highlighted hunk opens a **HunkReviewSheet** (bottom
sheet, medium detent — 50% viewport, expandable):

| Element | Treatment |
|---|---|
| **Changed text in context** | The hunk rendered with 2–3 lines of surrounding prose for context. Insertions in `success` tint, deletions in `destructive` tint + strikethrough. Sentence-level chunking for legibility. |
| **Provenance** | `text-xs`, `muted-foreground`: thread name + proposal ID |
| **Explanation** | If the assistant provided rationale, show it below the diff |
| **Sticky action bar** | Anchored at the bottom of the sheet: **Keep** / **Edit** / **Discard** buttons, 44px height, full-width. Keep = `success` ghost, Discard = `destructive` ghost, Edit = default ghost. |
| **Hunk navigation** | `← 2/5 →` in the sheet header. Prev/Next buttons advance to the next hunk (the sheet content updates without closing). |
| **Dismiss** | Swipe down or tap outside. Does NOT resolve the hunk — the writer must explicitly Keep, Edit, or Discard. |

> **Decision:** Per-hunk bottom sheet with sticky action bar for touch review.
> Swipe-to-accept is an optional gesture shortcut, not the primary path.
>
> **Rationale:** A bottom sheet keeps the review decision thumb-reachable and
> provides room for context + explanation. Inline buttons embedded in the
> editor text would be too small for reliable touch targets. Swipe-only review
> would be undiscoverable and high-risk for accidental actions.
>
> **Rejected:** Swipe-only (undiscoverable, no room for context). Inline
> miniature buttons in the editor (too small for touch). Full-screen modal
> per hunk (too heavy for quick review).
>
> *Evidence: mobile-chat-review.md §2 — "bottom sheets are a better fit for
> contextual decisions on small screens"; Material Design bottom sheets
> guidance.*

### Touch Gestures for Review

| Gesture | Action | Visible fallback |
|---|---|---|
| Tap highlighted hunk | Open HunkReviewSheet | The hunk highlight itself is the affordance |
| Swipe right on hunk text (in sheet) | Keep | Keep button in sticky bar |
| Swipe left on hunk text (in sheet) | Discard | Discard button in sticky bar |
| Swipe down on sheet | Dismiss (no action) | Close button in sheet header |

Swipe gestures on hunks are **optional shortcuts** — the first-time
experience shows a one-time tooltip: "Swipe right to keep, left to discard."
Every swipe action has a visible button fallback.

### Batch Actions on Phone

The `ProposalReviewToolbar` on Phone is a simplified version:
- Anchored at the bottom of the editor, above the AccessoryBar/BottomNav.
- Shows "Keep All" / "Discard All" + hunk counter ("3 pending").
- Tapping the counter opens the HunkReviewSheet at the first pending hunk.

### Inline Diff Rendering on Phone

> **Decision:** On Phone, inline hunk decorations use **stronger visual
> cues** than desktop: slightly higher background opacity (20% instead of
> 15%), a small leading marker (3px left border on the hunk's first line
> in `success` or `destructive` color), and sentence-level chunking.
>
> **Rationale:** On a small screen with variable lighting and no hover
> affordance, the hunks need to be more visually prominent to be
> discoverable as tappable regions. The leading marker provides a clear
> visual anchor. Sentence-level rendering avoids the "wall of tiny glyphs"
> problem.
>
> *Evidence: mobile-chat-review.md §3 — "avoid excessive color reliance;
> pair color with shape"; "on phones, suggestions should look like
> annotated prose, not a code review console."*

### Edit Flow on Phone

Tapping "Edit" in the HunkReviewSheet:
1. The sheet expands to full-height (90% viewport).
2. The hunk text becomes editable inside the sheet (a mini CM6 surface
   or a plain textarea, depending on implementation complexity).
3. The keyboard opens, and the AccessoryBar provides formatting actions.
4. "Done" button (replacing "Edit" in the sticky bar) commits the edit.
5. "Cancel" restores the original hunk and returns to review.

### Tablet Review

On Tablet, the desktop-style floating hunk widget works as-is (touch
targets are already 44px+). The HunkReviewSheet is available as an
alternative for portrait orientation where screen space is tighter.
Container-query the editor pane width: if < 500px, use the sheet; if
≥ 500px, use the floating widget.

---

## Document-Level Undo

Document-level undo stack for proposal operations. When the writer keeps or
discards a hunk, they can undo that action via the normal editor undo stack.

| Property | Value |
|---|---|
| Scope | Document-level — the editor's CM6/Yjs undo stack |
| Trigger | `Mod+Z` when the editor has focus and the last action was a review action |
| Visual | Subtle "Undo" button appears near the resolved hunk for 5 seconds |
| Stack depth | Standard CM6/Yjs undo depth |

**What's undoable:**
- Keep a hunk → undo restores the hunk to pending state
- Discard a hunk → undo restores the deleted text and the hunk decoration
- Keep All → undo restores all hunks to pending
- Discard All → undo restores all hunks and deleted text

**What's NOT undoable via document undo:**
- "Edit" action after the edit dialog is committed

> **Decision:** Undo is document-level, not per-thread. The editor's undo
> stack is the natural undo mechanism for the document — review actions are
> just another kind of document change. Per-thread undo adds complexity
> without benefit, especially since multiple threads can propose changes to
> the same document.
>
> **Rationale:** The writer is editing a document. Review actions (Keep/
> Discard) produce document mutations. The editor's undo stack already
> handles document mutations correctly. A separate per-thread undo would
> create confusing "which undo stack am I in?" moments.

---

## Proposal Lifecycle

```
   pending  ──→  accepted  (all hunks kept)
      │
      ├──→  rejected  (all hunks discarded)
      │
      ├──→  partial   (some hunks resolved, some pending)
      │
      └──→  mixed     (some kept, some discarded)
```

> **Decision:** `proposed` and `pending` are collapsed into a single
> pre-resolution state: `pending`. There is no distinction between "just
> arrived" and "under active review" — the proposal is simply "pending
> review" until the writer acts on it.
>
> **Rationale:** The `proposed`→`pending` distinction had no user-visible
> behavior change, no UI copy difference, and no actionable meaning. Both
> states used the same `warning` badge. Collapsing them simplifies the
> model without losing fidelity.

| Status | Badge variant | Meaning |
|---|---|---|
| `pending` | `warning` | Hunks awaiting review |
| `partial` | `warning` | Some hunks resolved, some still pending |
| `accepted` | `success` | All hunks kept |
| `rejected` | `secondary` (muted) | All hunks discarded |
| `mixed` | `secondary` | Some kept, some discarded |
