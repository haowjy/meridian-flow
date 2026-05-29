# Agents Mode

Agents answers: **"What is happening across this writing session?"**

This mode is **entirely new** — the current frontend has no equivalent.
Agents provides session-level orchestration for writers managing parallel
work threads across a project.

---

## Who Needs This

Fiction writers managing 100+ chapter serials routinely have multiple
concurrent concerns:

- Chapter planning + continuity checking running in parallel
- A critique thread, a rewrite thread, and a polish thread for the same arc
- Source-gathering and synthesis for a research-heavy chapter
- Background lore maintenance while actively writing

Without Agents, the writer must hold all of this in their head or switch
between threads manually in Converse. Agents externalizes the session state.

*Evidence: GitHub Copilot's agent management, VS Code chat sessions, and
Linear's team pages all demonstrate that exposing session/thread-level
orchestration as a first-class surface improves task management
(interaction-best-practices §1, §3).*

---

## Data Model

### Session

A **session** is a unit of related work within a project. It contains multiple
related threads (including branches and spawned-agent threads). A session has:

| Field | Type | Example |
|---|---|---|
| `id` | string | `sess_abc123` |
| `title` | string | "Chapter 12 Revision" |
| `status` | enum | `active`, `paused`, `completed` |
| `threadCount` | number | 5 |
| `activeThreadCount` | number | 2 |
| `createdAt` | timestamp | — |
| `lastActivityAt` | timestamp | — |

> **Decision:** A project has **multiple sessions.** A session is a bounded
> unit of related work (e.g., "Chapter 12 revision," "Continuity audit for
> Arc 3") containing multiple related threads.
>
> **Rationale:** Fiction writers managing 100+ chapter serials have multiple
> concurrent concerns (planning, continuity, critique, lore). A flat thread
> list cannot adequately express this parallel-work model. Sessions provide
> the grouping and orchestration layer Agents mode was designed for.
>
> **Rejected:** 1:1 Project↔Session. Collapses Agents to a simple thread
> list and removes the session-orchestration surface.

### Thread Family

Threads within a session form tree structures:

- A root thread can have **branches** (sibling forks at a specific turn)
- A thread can **spawn** child threads (agent-initiated sub-tasks)
- Thread families are displayed as grouped cards with parent/child indicators

---

## Layout

```
┌──────────────────────────────────────────────────────┐
│ Rail │  Session Header                                │
│ 48px │  ─────────────────────────────────────────────│
│      │  Session Dashboard (60%)  │  Thread Detail     │
│ [A]  │                           │  (40%)             │
│ [C]  │  ┌─────────────────────┐  │                    │
│ [S]  │  │ Thread Family Card  │  │  [Turn list]       │
│      │  │ "Ch 12 Main"        │  │                    │
│      │  │ ├─ Branch: Alt take │  │  [Tool activity]   │
│      │  │ └─ Spawn: Research  │  │                    │
│      │  └─────────────────────┘  │                    │
│      │                           │                    │
│      │  ┌─────────────────────┐  │  [Composer]        │
│ ⚙    │  │ Thread Family Card  │  │                    │
│      │  │ "Continuity Check"  │  │                    │
│      │  └─────────────────────┘  │                    │
├──────┴───────────────────────────┴────────────────────┤
│ Status Bar                                             │
└───────────────────────────────────────────────────────┘
```

### Session Header

| Property | Value |
|---|---|
| Height | 48px |
| Background | `--background` |
| Border | 1px `--border` on bottom |
| Content | Session title (editable), session status badge, session selector dropdown |

The session selector lets the writer switch between sessions within the
current project. If only one session exists, the selector is hidden.

### Session Dashboard (Left Pane, 60%)

The primary surface. Displays thread families for the active session.

**Scrollable card list** — each thread family is a card:

| Card element | Treatment |
|---|---|
| Root thread title | `text-base`, semibold, `foreground` |
| Thread tree | Indented list of branches + spawns, `text-sm`, `muted-foreground` |
| Status badge | Per-thread status: `streaming` (teal pulse), `idle` (muted), `error` (destructive) |
| Thread count | `text-xs`, `muted-foreground` |
| Last activity | `text-xs`, `muted-foreground`, relative timestamp |
| Active indicator | Left border 2px `accent-fill` on selected family |

**Card interactions:**
- Click → select the family, show root thread in Detail pane
- Click a specific branch/spawn → show that thread in Detail pane
- Right-click → context menu: Rename, Archive, Open in Converse
- Long-press card → same actions as context sheet (fallback: visible kebab button on the card)

**Empty state:** Centered message: "No active threads in this session" with
a "Start a conversation" button that switches to Converse.

### Thread Detail (Right Pane, 40%)

A read-only or lightly interactive view of the selected thread's conversation.

**Content:**
- Thread header (thread title, status badge, "Open in Converse" button)
- Turn list (same rendering as Converse, but in a narrower pane)
- Simplified composer (for quick replies without switching to Converse)

**Interactions:**
- Scroll through the conversation
- Expand/collapse tool groups
- Click "Open in Converse" → switch to Converse mode with this thread active
- Quick reply via the simplified composer
- "Review" actions on proposals work the same as in Converse

### Panel Resize

Dashboard and Detail panes are resizable via `PanelResizeHandle`.

| Property | Value |
|---|---|
| Default ratio | 60% / 40% |
| Min dashboard | 350px |
| Min detail | 300px |
| Double-click | Reset to 60/40 |
| Persistence | `meridian:panels:agents` |

---

## Activity Indicators

Agents surfaces what's happening across all threads:

### Streaming Indicator

When any thread in the session is actively streaming (assistant responding):
- The thread's card shows a subtle teal pulse dot next to the status badge
- The thread title in the tree uses `accent-text` color
- The Detail pane (if showing that thread) shows the streaming activity live

### Proposal Indicator

When a thread has proposals with pending hunks awaiting review:
- A `warning` badge appears on the card: "2 pending reviews"
- Clicking the badge opens that thread in Detail and scrolls to the first
  pending proposal's tool block

### Error Indicator

When a thread has errored:
- A `destructive` badge appears on the card
- The thread tree item shows `destructive` text

---

## Keyboard Navigation

| Shortcut | Action |
|---|---|
| `↑` / `↓` | Navigate between thread family cards |
| `Enter` | Select focused card, show in Detail |
| `→` | Move focus into the thread tree (branches/spawns) |
| `←` | Move focus back to card level |
| `Mod+Enter` | Open focused thread in Converse |
| `Mod+Shift+O` | New thread in current session |

---

## Responsive Behavior

### Tablet Tier (600–1199px)

**Landscape (≥ 900px):** Reduced split — Dashboard 60% / Detail 40%, same as
desktop but with smaller minimums (Dashboard 280px, Detail 250px). Rail is
visible.

**Portrait (< 900px):** Dashboard takes full width with BottomNav. Thread
Detail opens as push navigation (full-screen with a back button in the
header). Selecting a thread family pushes to the detail view.

### Phone Tier (< 600px)

Dashboard takes full width. BottomNav provides mode switching.

**Push navigation for detail:**
1. Tap a thread family card → push to a full-screen thread detail view.
2. Back button (Phosphor `ArrowLeft`, 44px touch target) in the header
   returns to the dashboard.
3. "Open in Converse" remains available in the detail header — tapping it
   switches to Converse via BottomNav.

**Session selector:** On Phone, the session selector moves from the header
to a bottom sheet triggered by the session title tap.

**Card layout on phone:**
- Cards are full-width (no horizontal padding beyond `padding-default`).
- Thread tree within cards is fully visible (no truncation) — the tree is
  important for understanding session structure.
- Status badges and activity indicators are the same as desktop.
- Pull-to-refresh on the card list reloads session data.
