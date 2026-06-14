# Agents Mode: Work Item + Thread UX

**Status:** draft

## Problem

The current Agents design is a generic dashboard that doesn't address the fiction writer's actual orchestration workflow. Writers need to:
- See a work item with its thread hierarchy at a glance
- Distinguish main vs side threads visually
- Know which threads are active, done, or need attention
- Drill into a thread to converse without losing work context
- See document changes across threads
- Get notified when threads complete

## Solution

### 1. Thread Hierarchy Display

Work items contain two tiers of threads:

**Main Threads** — primary work streams the writer is directing:
- Displayed as cards in a 2-column grid
- Full visual weight: title, agent badge, status, message preview, affected files, time
- 3px left accent border using status color (teal=active, green=done, amber=needs input)
- Card bg: paper-white with warm subtle border and shadow-sm

**Side Threads** — supporting/auxiliary work (research, checks, consultations):
- Displayed as compact list rows with separators (not full cards)
- Reduced visual weight: status dot, title, agent badge, status text, time
- Grouped under "Side Threads" header

**Why this distinction matters for writers:**
A writer's "Chapter 5 Revision" work might have 2 main threads for core revision tasks (pacing, voice) and 3 side threads for supporting work (research, continuity, style). The main threads deserve more visual real estate because they're where the writer's attention needs to go.

**Thread type is set at creation:** When spawning a thread in a work item, the writer (or agent) marks it as main or side. Default is main. Side threads are explicitly chosen for auxiliary work.

### 2. Status At a Glance

Each thread shows status via consistent visual language:

| Status | Indicator | Color | Meaning |
|--------|-----------|-------|---------|
| Streaming | Pulsing dot + bouncing gold dots | jade-teal + gold | AI is actively generating |
| Active | Solid dot | jade-teal | Thread is active, idle |
| Needs input | Solid dot + badge | amber | AI asked a question or hit a decision point |
| Done | Checkmark | green | Thread completed its task |

Work item header summarizes: "5 threads | 2 active | 3 files affected"

### 3. Thread Drill-In: Agents → Converse-Like View

When clicking a thread, the view transitions to a converse-like layout:

```
┌──────────────────────────────────────────────────────┐
│ Rail │  Breadcrumb Bar                                │
│ 48px │  ← Agents > Chapter 5 Revision > Pacing fbk  │
│      ├──────────────────────┬────────────────────────┤
│      │  Chat (~50%)         │  Document panel (~50%) │
│ [A]  │                      │                        │
│ [C]  │  conversation        │  single-view panel     │
│ [S]  │  with thread         │  (file explorer or     │
│      │                      │   active document)     │
│      │  ┌────────────────┐  │                        │
│      │  │ composer       │  │                        │
│      │  └────────────────┘  │                        │
├──────┴──────────────────────┴────────────────────────┤
│ Status Bar                                            │
└──────────────────────────────────────────────────────┘
```

**Breadcrumb bar** (36px, spans both panels):
- Back arrow returns to the work item dashboard
- Breadcrumb: Agents > [Work Item Name] > [Thread Name]
- Breadcrumb items are clickable (Agents → work items list, work item name → work item detail)
- Right side: thread status badge + agent profile badge

**Chat area** — same layout as Converse mode:
- AI messages: transparent, full-width, left-aligned (no bubble)
- User messages: right-aligned card bubbles
- Floating composer at bottom

**Document panel** — same simplified single-view as Converse v4:
- State 1: File explorer full-width (default)
- State 2: Active document with back arrow, MRU strip, editor mode tabs
- AI document references in chat open in this panel

**Key insight:** The drill-in IS Converse mode with a breadcrumb layer on top. Same components, same interactions, same document panel behavior. The only addition is the breadcrumb context that lets the writer navigate back to the work item dashboard.

### 4. Document Changes Across Threads

**In the work item dashboard:**

"Affected Files" section at the bottom shows a horizontal row of file pills:
- Each pill shows filename + thread count: `chapter-5.md (3 threads)`
- Clicking a pill could expand to show which threads touched it
- Files with recent changes get a subtle highlight

**In the thread drill-in:**

When the AI references or edits a document, the document panel shows it with relevant context. If proposals/hunks exist, they appear inline in the editor (same as Studio's proposal review).

**Cross-thread change summary** is a future enhancement — v1 shows per-thread document interaction. Diffing across threads is complex and deferred.

### 5. Real-Time Updates (SSE/WebSocket)

The Agents mode maintains a persistent project-level connection (SSE). When a thread finishes or produces results:

**Toast notification** (top-right, floating):
- Slides in from right edge, 320px wide
- Paper-white card with 3px left green border, subtle shadow
- Content: green check icon + "Thread completed" title + thread name + findings summary
- Actions: "Review" teal button + dismiss X
- Auto-dismiss after 8 seconds, or persist if actionable

**In-place thread update:**
- The completed thread's row/card transitions from its previous status to "Done"
- Subtle warm highlight/glow on the row for ~5s to draw attention
- "NEW" badge appears next to status for recently completed threads
- Badge clears when the writer clicks into the thread

**Affected files update:**
- If the completed thread modified files, the Affected Files section updates
- Thread counts increment with a subtle teal highlight on the changed count

**Connection indicator** in status bar:
- "Live updates active" with pulsing green dot when SSE connection is healthy
- "Reconnecting..." with amber pulse when connection drops
- Reconnection is automatic; the UI queues missed events and replays on reconnect

### 6. Thread Card Information Density

**Main thread cards** (full cards in 2-column grid):
```
┌────────────────────────────────────┐
│ ● Pacing feedback          3m ago │
│ reviewer                          │
│ ●●● Streaming...                  │
│                                   │
│ The transition between the        │
│ sparring scene and the            │
│ meditation sequence feels...      │
│                                   │
│ 12 messages | chapter-5.md        │
└────────────────────────────────────┘
```
- Title (15px semibold) + relative time
- Agent badge (bg-muted rounded text-xs)
- Status line with indicator
- Message preview (2 lines, 13px muted)
- Footer: message count + affected file pills

**Side thread rows** (compact list):
```
● Research: historical accuracy    researcher    Needs input    1h ago
```
- Status dot + title + agent badge + status text + time
- Single line, ~40px height
- Separated by subtle warm borders

This density balance ensures main threads get visual priority while side threads remain scannable without dominating the view.

## Mobile: Work Item Detail (390x844)

On mobile, the work item detail is a scrollable single-pane view:

```
┌──────────────────────────┐
│ ← Chapter 5 Revision  ⋮ │  nav bar
│ Active                   │
│ Rework pacing and...     │  work item info
│ 5 threads | 2 active     │
├──────────────────────────┤
│ MAIN THREADS             │
│ ┌──────────────────────┐ │
│ │ ● Pacing feedback    │ │  full-width card
│ │ Streaming... ●●●     │ │
│ │ The transition...    │ │
│ └──────────────────────┘ │
│ ┌──────────────────────┐ │
│ │ ✓ Character voice    │ │  full-width card
│ │ Done                 │ │
│ │ Voice consistency... │ │
│ └──────────────────────┘ │
│ SIDE THREADS             │
│ ● Research: historical.. │  compact rows
│ ✓ Continuity check...    │
│ ✓ Style guide...         │
├──────────────────────────┤
│ [Agents] [Converse] [Studio] │  tab bar
└──────────────────────────┘
```

- Tapping a thread card pushes to a full-screen Converse-like view (chat + bottom sheet for document context)
- Back arrow returns to work item detail
- Tab bar handles mode switching (no cross-mode CTAs)

## Design Decisions

### Why cards for main threads, rows for side threads?
Main threads represent the writer's primary focus — they deserve card-level visual weight with message previews and file information. Side threads are supporting work that the writer glances at for status, not deeply engages with from the dashboard.

### Why breadcrumb, not back button, for drill-in?
A breadcrumb gives the writer orientation: "I'm in Agents > Chapter 5 Revision > Pacing feedback." A bare back button doesn't communicate where "back" goes. The breadcrumb also enables skipping levels (click "Agents" to go all the way back to the work items list).

### Why single-view document panel in drill-in?
Consistency with Converse mode. The drill-in IS Converse mode with work context. Using a different document panel layout would be jarring and increase implementation surface.

### Why toast + in-place update for notifications?
The toast catches attention when the writer might not be looking at the dashboard (they could be scrolled down, focused on a different thread card, etc.). The in-place update provides persistent visual state change after the toast dismisses. Both together give immediate awareness and durable state.

### Why not a timeline for threads?
Timelines imply sequential ordering, but threads in a work item are parallel and independent. A grid (main) + list (side) better represents the concurrent, non-sequential nature of multi-thread orchestration.

## SuperDesign References

| Design | Draft ID | Preview |
|--------|----------|---------|
| Agents Dashboard | `d6fca02f-241a-4b2b-a9aa-357e10de0e4b` | [Preview](https://p.superdesign.dev/draft/d6fca02f-241a-4b2b-a9aa-357e10de0e4b) |
| Thread Drill-In | `9cba2717-c911-4da2-b7bd-b39635de36a9` | [Preview](https://p.superdesign.dev/draft/9cba2717-c911-4da2-b7bd-b39635de36a9) |
| Notification Moment | `cb1ca6e5-0235-4ead-b20b-39435bc4fab7` | [Preview](https://p.superdesign.dev/draft/cb1ca6e5-0235-4ead-b20b-39435bc4fab7) |
| Mobile Work Item | `e6f5c930-e01d-47be-8b0f-4aaff1d4be2a` | [Preview](https://p.superdesign.dev/draft/e6f5c930-e01d-47be-8b0f-4aaff1d4be2a) |

## Cross-References

- [Work Items Backend Design](../agents/work-items.md) -- domain model, API contracts
- [Threads Feature](../threads/threads.md) -- thread data architecture
- [Layout Architecture](layout-architecture.md) -- panel sizing, responsive tiers
- [Converse Panel UX](converse-panel-ux.md) -- simplified document panel (shared with drill-in)
- [Visual Designs](visual-designs.md) -- all design draft links
