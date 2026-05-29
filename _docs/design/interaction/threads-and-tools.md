# Threads & Tools

How conversations with the assistant are rendered — turns, tool activity,
streaming state, and the visual rhythm of a chat session.

---

## Turn Rendering

A thread is a sequence of **turns**. Each turn is rendered as a distinct
visual block in the turn list.

### Turn Types

| Type | Visual treatment | Content |
|---|---|---|
| **UserTurn** | Subtle `muted` background tint (~30% opacity), `radius-lg` | User message blocks (text, images, references) |
| **AssistantTurn** | Bare canvas background | Activity block (content, thinking, tool use) |
| **SystemTurn** | Centered, `text-sm`, `muted-foreground`, no background | Compaction markers, collapse indicators |

> **Decision:** Full-width turns with role-distinguished backgrounds, not
> left/right bubble alignment.
>
> **Rationale:** Full-width maximizes the reading column on desktop (where
> horizontal space is abundant) and matches the literary, editorial feel.
> Bubble alignment is a mobile chat-app convention that wastes space and
> creates a casual tone inconsistent with a "serious creative tool."
>
> **Rejected:** Left/right bubble alignment. Also rejected: identical
> backgrounds with only a name/avatar distinguisher — too little visual
> distinction between roles.

### Turn Layout

```
┌─ Turn list (max-w-3xl, centered) ──────────────────────┐
│                                                         │
│  ┌── User Turn (muted bg, radius-lg) ────────────────┐  │
│  │  User message text in iA Writer Quattro            │  │
│  │  [Optional: image blocks, reference chips]         │  │
│  └────────────────────────────────────────────────────┘  │
│                                                         │
│  ── Assistant Turn (no bg) ───────────────────────────   │
│  │  Content text in iA Writer Quattro                 │  │
│  │                                                    │  │
│  │  ┌── Tool Group (collapsed by default) ─────────┐  │  │
│  │  │ ▶ 3 actions: Read, Edit, Search              │  │  │
│  │  └──────────────────────────────────────────────┘  │  │
│  │                                                    │  │
│  │  More content text...                              │  │
│  ─────────────────────────────────────────────────────   │
│                                                         │
│  ── System Turn (centered) ───────────────────────────   │
│  │  "Context compacted · 3 turns summarized"          │  │
│  ─────────────────────────────────────────────────────   │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Turn Spacing

| Gap | Value |
|---|---|
| Between turns | `padding-default` (12px) |
| Between blocks within a turn | `padding-compact` (8px) |
| Turn padding (user turns) | `padding-default` all sides |
| Turn padding (assistant turns) | `padding-default` top/bottom only |

### Turn Content Typography

| Element | Font | Size | Weight | Color |
|---|---|---|---|---|
| Prose text (both roles) | iA Writer Quattro | `text-base` | 400 | `foreground` |
| Inline code | Geist Mono | 0.9em | 400 | `foreground`, `muted` bg |
| Code block | Geist Mono | `text-sm` | 400 | `foreground`, `muted` bg |
| Heading in content | iA Writer Quattro | `text-lg`–`text-xl` | 700 | `foreground` |
| Link | iA Writer Quattro | inherit | 400 | `accent-text`, underlined |

---

## Tool Activity Display

Tool use is rendered inline within assistant turns. The existing activity
stream architecture (35 files in `features/activity-stream/`) handles
classification, streaming, and nested rendering.

### Tool Groups

Consecutive tool calls are grouped into a **tool group** — a collapsible
section that defaults to **collapsed**.

| Property | Value |
|---|---|
| Background | `muted` at ~50% opacity |
| Border | 1px `border`, `radius-md` |
| Padding | `padding-compact` |
| Header font | `text-sm`, Geist, medium weight |
| Collapsed display | "▶ 3 actions: Read, Edit, Search" (summary of tool names) |
| Expanded display | Individual tool blocks stacked vertically |

### Tool Group States

| State | Visual |
|---|---|
| Collapsed (default) | Summary header, single line, Phosphor `CaretRight` icon |
| Expanded | Full tool blocks visible, Phosphor `CaretDown` icon |
| Streaming | Animated ellipsis or spinner after the tool count |

### Thinking Groups

A thinking block + its associated tools form a **thinking group**. Same
visual treatment as a tool group but with a thinking preamble.

| Property | Value |
|---|---|
| Thinking text | `text-sm`, `muted-foreground`, italic, Geist |
| Thinking max-height | 4 lines when collapsed, scrollable when expanded |
| Thinking + tools | Grouped together, single collapse toggle |

### Individual Tool Blocks

When a tool group is expanded, each tool call renders as a detail card.

| Property | Value |
|---|---|
| Background | `card` |
| Border | 1px `border`, `radius-md` |
| Padding | `padding-compact` |

**Tool header:**
- Tool icon (from tool classification — `BookOpen`, `PencilSimple`,
  `MagnifyingGlass`, `Terminal`, `Globe`, `Robot`)
- Tool label (progressive: starts as "Tool", becomes "Read", then
  "Read(src/components/Button.tsx)")
- Status indicator: spinner (executing), checkmark (done), `X` (error)

**Tool detail** (varies by classification):

| Classification | Detail component | Content |
|---|---|---|
| `read` | ToolDetail | File path, content preview (truncated) |
| `edit` | EditDetail | File path, diff view (insertions green, deletions red) |
| `doc-search` | SearchDetail | Query, match count, file list |
| `web-search` | WebSearchDetail | Query, result list with titles |
| `bash` | BashDetail | Command, stdout/stderr (scrollable, mono font) |
| `agent` | AgentDetail | **Recursive** — nested `ActivityBlock` for sub-agent activity |
| `other` | ToolDetail | Generic arg/result display |

### Nested Agent Activity

Agent tool calls (`spawn`, `delegate`, `thread`) render a nested activity
block inside the parent tool detail. This recurses — an agent can spawn
sub-agents.

Visual nesting:
- Each nesting level indents 16px
- Nested blocks use a slightly lighter/darker `card` background
- Nesting depth is capped at 3 visually (deeper levels collapse to a link)

---

## Streaming Display

### While the Assistant Is Responding

| Element | Behavior |
|---|---|
| Content text | Renders token-by-token, cursor at end |
| Tool activity | Progressive labels update as `parsedArgs` build |
| Thinking | Italic, muted, streaming text |
| Scroll | Auto-scroll to bottom (unless user has scrolled up) |
| Composer | Send button replaced by Stop button (`StopCircle`, `destructive`) |

### Streaming Indicator

A subtle, non-intrusive indicator that the assistant is responding:
- The most recent assistant turn shows a small teal pulse dot next to the
  timestamp area
- No full-width progress bar, no bouncing dots, no loading spinner replacing
  content

### Interruption

| Action | Effect |
|---|---|
| Click Stop | Cancels the current generation. Partial content remains visible. |
| Type in composer while streaming | Queues the message to send after current generation completes |
| `Escape` while streaming | Same as clicking Stop |

*Evidence: VS Code chat sessions support queue/steer/stop for interruption.
This matches (interaction-best-practices §1).*

---

## Turn Status

Each turn can have a status banner:

| Status | Visual | When |
|---|---|---|
| Streaming | Teal pulse dot | Assistant is generating |
| Error | `destructive` banner below turn: "Something went wrong" + retry button | Generation failed |
| Cancelled | `muted-foreground` text: "Stopped" | User cancelled generation |

### Error Recovery

- Error turns show a "Try again" button that re-sends the last user message
- The failed assistant turn remains visible (partial content preserved)
- A new assistant turn is created for the retry (the error turn is not replaced)

---

## Branch Navigation

Threads support branching (editing a previous user message creates a sibling
fork). Branches are navigated via the **SiblingNav** component on the forked
turn.

| Property | Value |
|---|---|
| Position | Below the turn that was edited |
| Visual | `text-sm`, `muted-foreground`: "← 1/3 →" |
| Controls | Phosphor `CaretLeft` / `CaretRight` to switch between siblings |
| Keyboard | `Alt+←` / `Alt+→` when the branching turn is focused |

---

## Proposal Quick Actions

When an assistant turn produces a proposal (document edit), the turn displays
proposal status and quick actions inline:

| Element | Visual |
|---|---|
| Proposal status badge | `Badge` component: `pending` (warning), `partial` (warning), `accepted` (success), `rejected` (muted), `mixed` (secondary) |
| Quick action buttons | "Keep All" / "Discard All" / "Review" — small ghost buttons next to the badge |
| "Review" action | Opens the target document in the editor pane and scrolls to the first pending hunk |

See `interaction/proposals-review.md` for the full review flow.

---

## Mobile Chat Surface

How the conversation surface adapts on Phone and Tablet. The core rendering
(turns, tool groups, proposals) is identical; the chrome and interaction
model adapt to touch.

> **Decision:** The mobile chat surface uses **medium density** (relaxed turn
> spacing, no `max-w-3xl` constraint on Phone), **phrase/sentence-chunked
> streaming** (stable text, no mid-word jitter), a **toggled send-vs-stop
> button** (never shown simultaneously — avoids accidental-tap risk on a
> phone), and reuses `FloatingScrollLayout` for **jump-to-latest** with a
> floating pill. Tool groups and agent detail open as **bottom sheets**
> (BottomSheet component) on Phone to avoid deeply nested inline content on
> narrow screens.
>
> **Rationale:** A phone conversation surface must balance content density
> against readability, respect thumb-reach for send/stop, and avoid the
> visual clutter of deeply nested inline tool output. Each adaptation is
> driven by a concrete mobile constraint (screen width, touch ergonomics,
> single-pane model) rather than a one-size-fits-all desktop parity target.
>
> **Rejected:** Full desktop parity on Phone (walls of text, undiscoverable
> stop, deeply nested inline content). Bubble-chat alignment (casual/chat-app
> feel, wastes horizontal space).

*Evidence: mobile-chat-review.md §1 — "the mobile chat surface should feel
like a conversation-first bottom workspace: stable scrolling, simple
composer, explicit stop, and a restrained visual system."*

### Message Density on Phone

> **Decision:** Medium density on Phone — not desktop parity.
>
> **Rationale:** Desktop turn lists fit comfortably in a wide reading column.
> On a phone, the same density creates a wall of text. Generous vertical
> spacing (slightly increased turn gap), shorter paragraphs in streaming
> output, and collapsed-by-default tool groups keep the conversation
> scannable.

Specific adjustments on Phone (< 600px):
- Turn gap: `padding-relaxed` (16px) instead of `padding-default` (12px)
- Turn content uses the full viewport width minus `padding-default` on
  each side (no `max-w-3xl` constraint — the screen is already narrow)
- User turn padding: `padding-default` all sides (same as desktop)
- Tool groups default to collapsed (same as desktop — no change needed)

### Streaming Display on Phone

- **Phrase/sentence chunking:** Content streams in readable phrases, not
  token fragments. The rendering should buffer and flush at natural word
  boundaries where possible, so the screen updates progressively without
  mid-word jitter.
- **Stable text:** Once text is committed to the DOM, it does not reflow.
  The scroll position of previously rendered turns stays fixed.
- **Visible "still generating" state:** The teal pulse dot (same as
  desktop) plus a small "Generating..." label below the streaming content
  on Phone (where the dot alone might be missed).

### Send vs Stop on Phone

The Composer's send/stop distinction is critical on phone because the
writer's thumb rests near the send area.

| State | Button | Icon | Color | Position |
|---|---|---|---|---|
| Idle | Send | `PaperPlaneTilt` | `accent-fill` | Right side of composer |
| Streaming | Stop | `StopCircle` | `destructive` | Same position — replaces Send |

> **Decision:** Send and Stop are **never shown simultaneously.** The button
> is a state toggle: Send when idle, Stop when streaming.
>
> **Rationale:** Two adjacent action buttons for send and stop create
> accidental-tap risk on a phone. OpenAI's ChatGPT mobile similarly uses a
> single button that toggles between send and stop.
>
> *Evidence: mobile-chat-review.md §1 — "separate 'send' from 'stop
> generation'; these should not be visually ambiguous."*

### Jump-to-Latest

On Phone, `FloatingScrollLayout` already implements stick-to-bottom and a
scroll-to-bottom button. The mobile adaptation:

- **Jump-to-latest pill:** A floating pill ("↓ New messages" or "↓ Jump to
  latest") appears when the user has scrolled up during streaming.
- **Position:** Bottom-center of the thread pane, above the composer.
- **Behavior:** Tapping scrolls to the bottom and re-enables auto-stick.
  The pill disappears when the user is at the bottom.
- **Respect scroll-up:** If the user scrolls up, auto-stick disengages.
  The assistant keeps streaming, but the viewport stays where the user
  put it. Only the jump-to-latest pill signals new content below.

*Evidence: mobile-chat-review.md §1 — "auto-stick while generating, but
stop fighting the user if they scroll up."*

### Tool Groups & Agent Detail on Phone

- **Tool groups:** Same collapsed-by-default behavior. Tap to expand
  (no hover). The expand/collapse toggle area is the full group header
  (not just the caret icon) — larger touch target.
- **Nested agent detail:** On Phone, agent tool blocks that contain nested
  activity render a "View agent activity" link instead of inline nesting.
  Tapping opens a **bottom sheet** with the nested activity stream
  (full-height, scrollable). This avoids deeply indented nested content
  on a narrow screen.
- **Long tool output** (bash stdout, large file reads): Capped at 10 lines
  on Phone with a "Show more" expander. The expander opens a full-screen
  sheet for the complete output.

### Branch Navigation on Phone

SiblingNav controls ("← 1/3 →") use 44px touch targets for the prev/next
arrows. Swipe left/right on the branching turn is an optional gesture
shortcut (with the arrow buttons as fallback).
