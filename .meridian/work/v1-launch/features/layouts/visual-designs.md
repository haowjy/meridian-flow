# Visual Layout Designs

**Status:** draft
**SuperDesign Project:** [Meridian Layouts](https://app.superdesign.dev/teams/954a4a93-ca61-4ed5-b13d-26b8f134b4ae/projects/24a5db2c-e5fe-42d0-99f1-57c8d81a57d5)
**Project ID:** `24a5db2c-e5fe-42d0-99f1-57c8d81a57d5`

## Desktop Design Drafts

### Studio Mode (editor-primary)

| Tier | Viewport | Draft ID | Preview | Notes |
|------|----------|----------|---------|-------|
| **Expanded** | 1440x900 | `3bf284bc-b28e-4acc-8855-f70bc502713f` | [Preview](https://p.superdesign.dev/draft/3bf284bc-b28e-4acc-8855-f70bc502713f) | v3: chat sidecar + editor mode tabs (Live Preview / Source segmented control) |
| Medium | 1024x768 | `3ee0b373-82d9-44ca-9fec-2e9b90b2efdb` | [Preview](https://p.superdesign.dev/draft/3ee0b373-82d9-44ca-9fec-2e9b90b2efdb) | |
| Compact | 768x900 | `3706a512-5e87-4217-bde5-45f1d29446f2` | [Preview](https://p.superdesign.dev/draft/3706a512-5e87-4217-bde5-45f1d29446f2) | |

### Converse Mode (chat-primary)

| Tier | Viewport | Draft ID | Preview | Notes |
|------|----------|----------|---------|-------|
| **Expanded -- File Explorer state** | 1440x900 | `2f83e262-66f6-4ebe-a968-57648a0f3a74` | [Preview](https://p.superdesign.dev/draft/2f83e262-66f6-4ebe-a968-57648a0f3a74) | v4: simplified single-view panel -- file explorer full-width when no doc is open |
| **Expanded -- Active Document state** | 1440x900 | `4d7cfb1c-e953-4961-bc8b-37c71d840edd` | [Preview](https://p.superdesign.dev/draft/4d7cfb1c-e953-4961-bc8b-37c71d840edd) | v4: simplified single-view panel -- document with back arrow, MRU strip, editor mode tabs |

### Agents Mode (orchestration)

| Tier | Viewport | Draft ID | Preview | Notes |
|------|----------|----------|---------|-------|
| **Dashboard -- Work Item Detail** | 1440x900 | `d6fca02f-241a-4b2b-a9aa-357e10de0e4b` | [Preview](https://p.superdesign.dev/draft/d6fca02f-241a-4b2b-a9aa-357e10de0e4b) | Work item with thread hierarchy: main threads (cards) + side threads (rows) + affected files |
| **Thread Drill-In** | 1440x900 | `9cba2717-c911-4da2-b7bd-b39635de36a9` | [Preview](https://p.superdesign.dev/draft/9cba2717-c911-4da2-b7bd-b39635de36a9) | Converse-like view with breadcrumb back to dashboard, chat + document panel |
| **Notification Moment** | 1440x900 | `cb1ca6e5-0235-4ead-b20b-39435bc4fab7` | [Preview](https://p.superdesign.dev/draft/cb1ca6e5-0235-4ead-b20b-39435bc4fab7) | Dashboard with toast notification, in-place thread completion update, SSE live indicator |

## Mobile Design Drafts (390x844, iPhone 14)

Mobile is post-v1 scope but designed now to inform responsive component architecture decisions.

| Mode | Draft ID | Preview | Key Patterns |
|------|----------|---------|--------------|
| **Studio** | `f303c313-a8f3-4d81-96a1-4c41848aed87` | [Preview](https://p.superdesign.dev/draft/f303c313-a8f3-4d81-96a1-4c41848aed87) | Fresh writer-first design: file explorer, full-screen iA Writer Quattro editor with realistic prose, chat bottom sheet with drag handle |
| **Converse** | `9c81e258-0dab-4d43-940d-88e7a5d59431` | [Preview](https://p.superdesign.dev/draft/9c81e258-0dab-4d43-940d-88e7a5d59431) | Cross-mode CTAs removed from document context bottom sheet |
| **Agents** | `17c6b4a6-44c2-4952-8144-259496a2260d` | [Preview](https://p.superdesign.dev/draft/17c6b4a6-44c2-4952-8144-259496a2260d) | Cross-mode CTAs removed from panels and cards |
| **Agents (work item detail)** | `e6f5c930-e01d-47be-8b0f-4aaff1d4be2a` | [Preview](https://p.superdesign.dev/draft/e6f5c930-e01d-47be-8b0f-4aaff1d4be2a) | Work item detail with main thread cards + side thread rows, thread navigation, tab bar |

### Mobile Design Principles

- Bottom tab bar (48px) replaces left rail: Agents, Converse, Studio
- Single-pane navigation with push/pop transitions (no split panes)
- Bottom sheets replace side panels/drawers for secondary content -- peek/dismiss only, NO cross-mode CTAs
- Full-screen editor when editing (chat accessible via bottom sheet drag handle)
- 44px minimum touch targets everywhere
- Status/connection info in top safe area or navigation bar

## Component Map

| Item | Draft ID | Preview | Notes |
|------|----------|---------|-------|
| Extended with Chat Components | `399be9d0-b759-49f1-88e0-6481d8c76e86` | [Preview](https://p.superdesign.dev/draft/399be9d0-b759-49f1-88e0-6481d8c76e86) | Rail, resize handles, tabs, messages, explorer, status bar + detailed chat specimens (user cards, AI messages, thinking blocks, tool groups, composer, action bars, reference pills) |
| **Tool Call Components** | `6d649dff-2c3f-4869-bda4-206bc8b2fa28` | [Preview](https://p.superdesign.dev/draft/6d649dff-2c3f-4869-bda4-206bc8b2fa28) | All tool call variants: read (single/multi/streaming), edit (pending/accepted/rejected/streaming), search (results/empty/streaming), code execution (success/error/running), grouped smart summary |

## Tool Call Designs

Type-specific tool call displays for the chat thread. See [tool-call-design.md](../threads/tool-call-design.md) for full design rationale.

| Design | Draft ID | Preview | Notes |
|--------|----------|---------|-------|
| Full AI Turn (read + think + edit) | `c347c600-ef6e-4ae9-a34d-d121cfa1c98e` | [Preview](https://p.superdesign.dev/draft/c347c600-ef6e-4ae9-a34d-d121cfa1c98e) | Complete turn showing compact reads, AI text, prominent edit card with diff + accept/reject |
| Document Edit Detail | `b57ff024-6c20-47fc-a3f7-56d86212e0ad` | [Preview](https://p.superdesign.dev/draft/b57ff024-6c20-47fc-a3f7-56d86212e0ad) | Three states: pending review (hero), accepted, partially reviewed with per-hunk status |
| Search Results | `6a8f4bc5-0d22-4b3a-a6ac-347a8a71e351` | [Preview](https://p.superdesign.dev/draft/6a8f4bc5-0d22-4b3a-a6ac-347a8a71e351) | Concordance-style search results with snippets and match highlighting |
| Grouped Collapsed vs Expanded | `35b6363b-e0ff-425c-a7a8-f77e508ac602` | [Preview](https://p.superdesign.dev/draft/35b6363b-e0ff-425c-a7a8-f77e508ac602) | Smart summary with category icons + counts; expanded shows type-specific renderers |
| Streaming State | `e7708abd-1e18-40b6-b226-780cabdc3dc7` | [Preview](https://p.superdesign.dev/draft/e7708abd-1e18-40b6-b226-780cabdc3dc7) | In-progress turn: completed read, active edit with shimmer, queued search |

## Design Decisions

### Color Application
- Rail uses dark warm brown (#2A2520) as a constant across all modes -- provides stable navigation anchor
- Explorer uses slightly-darker-than-paper (#F0ECE4) for subtle depth separation
- Tab bar uses #EFEBE3 to sit between explorer and editor
- Editor content area uses the signature Paper #F6F2EA
- Chat messages differentiate user (#EDE8E0) vs AI (#FAF7F1) by warmth, not color

### Active State Language
- Rail: 3px left border in jade-teal + teal icon tint
- Tabs: bottom 2px teal border + paper-white background
- Explorer files: subtle teal left border + background highlight
- Work items: 3px left teal border on selected card
- Thread cards: 3px left border in status color (teal=active, green=done, amber=needs input)
- MRU document pills: subtle teal left accent on active pill
- Mobile tab bar: teal icon + label for active tab, muted for inactive

### Chat UI Patterns (carried from existing frontend)
1. **User messages**: right-aligned card bubbles with bg-card, border, shadow elevation, rounded-lg, max-width 95% (85% on mobile), compact padding (px-2.5 py-1.5). Hover gets stronger shadow.
2. **AI messages**: NO card/bubble -- transparent, full-width, left-aligned. Content blocks with gap-2 spacing. AI content breathes and feels part of the page.
3. **Streaming indicator**: three bouncing gold (#F4B41A) dots, staggered 160ms animation.
4. **Thinking blocks**: native details/summary, bg-muted/30, 2px amber left border accent, shimmer animation while streaming.
5. **Tool groups**: type-aware smart summary (category icons + counts instead of generic wrench + count). Edits get visual prominence. See [tool-call-design.md](../threads/tool-call-design.md) for per-type rendering.
6. **Floating composer**: positioned at bottom of scroll area (floats over messages). CM6 editor (14px, max 200px, auto-expanding) + control bar (model selector, reasoning toggle, tools toggle, send button). Mobile: simplified control bar.
7. **Turn action bar**: hidden by default, appears on hover (group-hover:opacity-100). Copy, Edit (user only), Regenerate (AI only). Sibling navigation arrows with counter when branched.
8. **Reference pills**: inline badges with file icon, truncated name, bg-muted border rounded-[4px] px-1.5 py-px text-xs. Broken links get dashed underline.
9. **Scroll-to-bottom**: floating circular button above composer, opacity animated.

### Converse Document Panel (v4 -- single-view)
- Documents panel is a SINGLE VIEW, NOT a tree+editor split
- State 1 (default): full-width file explorer when no doc is open
- State 2 (active): document content with back arrow + filename + editor mode tabs + MRU strip
- Push/replace navigation: clicking a file replaces explorer with document, back arrow returns to explorer
- MRU strip: compact horizontal row of recently opened document pills for fast switching
- Chat document references open in the panel, replacing whatever is active
- See [converse-panel-ux.md](converse-panel-ux.md) for full UX spec

### Agents Thread Hierarchy
- Main threads: cards in 2-column grid with full visual weight (title, agent, status, preview, files, time)
- Side threads: compact list rows with reduced visual weight (status dot, title, agent, status text, time)
- Thread type set at creation (main=default, side=explicit)
- Status indicators: streaming (pulsing teal + gold dots), active (solid teal), needs input (amber), done (green check)
- Thread drill-in: converse-like view with breadcrumb bar for navigation back to dashboard
- See [agents-work-item-ux.md](agents-work-item-ux.md) for full UX spec

### Agents Real-Time Updates
- Persistent SSE/WebSocket connection per project in Agents mode
- Toast notifications on thread completion: paper-white card with 3px green left border, slides in from right
- In-place thread state updates: row/card transitions with highlight glow + NEW badge
- Affected files section updates with changed thread counts
- Status bar shows "Live updates active" with pulsing green dot

### Editor Mode Tabs
- Compact pill-shaped segmented control in editor toolbar area
- Two tabs: 'Live Preview' (default) and 'Source'
- Designed to accommodate future third tab ('Preview') without rework
- 28-30px height, rounded-full, warm subtle border
- Active: paper-white bg with subtle shadow; inactive: transparent with muted text
- Present in both Studio and Converse editor areas

### Responsive Strategy (Desktop)
- Expanded (>=1200px): all panes visible, resizable
- Medium (840-1199px): one secondary pane at a time, toggles
- Compact (<=839px): single primary pane, drawers for secondary

### Mobile Strategy
- Bottom tab bar replaces left rail
- Push/pop navigation stack (not split panes)
- Bottom sheets for secondary surfaces (chat in Studio, document context in Converse)
- Bottom sheets are peek/dismiss only -- no cross-mode CTAs (tab bar handles mode switching)
- Context menus via bottom sheets (not dropdowns)
- Pull-to-refresh on list views

### Component Specimens Covered
1. Rail with all interaction states (default, hover, active) in light + dark
2. Panel resize handles (default, hover, dragging)
3. Tab bar (active, inactive, dirty, hover, overflow) in light + dark
4. Thread messages (user card, AI transparent, tool call, streaming) in light + dark
5. File explorer tree (folder expanded/collapsed, file default/active/hover) in light + dark
6. Status bar (connected, reconnecting, low credits) in light + dark
7. Chat-specific: thinking blocks (collapsed/expanded), tool groups (with status variants), turn action bars, reference pills (normal/broken), floating composer (focused/unfocused), scroll-to-bottom button
8. Editor mode segmented control (Live Preview / Source)
9. Tool call components: read (single/multi/streaming), edit (pending/accepted/rejected/streaming), search results, code execution, grouped smart summary (collapsed/expanded)
10. Thread cards (main: full card with status, preview, files; side: compact row)
11. Work item header (title, status badge, description, stats)
12. Toast notification (thread completion, paper-white with green left border)
13. MRU document pills (active with teal accent, inactive, dismiss on hover)
14. Breadcrumb bar (Agents > Work Item > Thread navigation)

## Iteration Notes

These designs are iterative drafts for review. To iterate on any design:

```bash
# Branch a variation from any draft
superdesign iterate-design-draft --draft-id <draft-id> \
  -p "description of change" \
  --mode branch \
  --context-file .superdesign/design-system.md \
  --context-file frontend-v2/src/index.css

# Read the current design HTML
superdesign get-design --draft-id <draft-id>
```
