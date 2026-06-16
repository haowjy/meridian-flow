# Tool Call Display Design

**Status:** draft
**SuperDesign Project:** [Meridian Layouts](https://app.superdesign.dev/teams/954a4a93-ca61-4ed5-b13d-26b8f134b4ae/projects/24a5db2c-e5fe-42d0-99f1-57c8d81a57d5)

## Problem

When the AI assistant works with a writer, it uses tools (read, edit, search, execute). The current frontend groups all tool calls into a generic collapsible block with a wrench icon, tool count, and status indicator. This is functional but opaque -- the writer can't see WHAT the AI did or WHY without expanding and reading JSON.

## Design Philosophy: Manuscript Marginalia

The visual metaphor is **editor's marginalia on a manuscript**. Like a professional editor working through a manuscript, different marks serve different purposes:

- **Reads** = silently turning pages (barely visible, background action)
- **Edits** = the editor's marks in the margin (bold, actionable, the heart of collaboration)
- **Searches** = concordance entries (structured reference information)
- **Code execution** = typesetter's technical notes (set apart from creative content)

This metaphor works with Meridian's paper aesthetic and positions the AI as a skilled editor collaborating on the writer's work.

## Visual Hierarchy

Tool calls are ranked by how much writer attention they need:

| Priority | Tool Type | Visual Weight | Default State | Writer Action |
|----------|-----------|---------------|---------------|---------------|
| Highest | Document Edit | Prominent warm card, jade-teal left border | Expanded | Accept/Reject (required) |
| Medium | Search Results | Clean card with results list | Collapsed with match count | Click to open docs (optional) |
| Low | Code Execution | Espresso-tinted output area | Collapsed with status | Read output (optional) |
| Lowest | Document Read | Ultra-compact inline | Collapsed to single line | None (informational) |

## Component Designs

### 1. Document Read

**Design**: Ultra-compact single line. NOT a full card -- just a whisper in the conversation.

```
BookOpen  Read chapter-3.md                    ✓
```

Multiple reads collapse to a summary:

```
BookOpen  Read 3 documents                     ✓  ▾
  └ chapter-3.md
  └ chapter-5.md
  └ character-profiles.md
```

**Rationale**: Reading is a background action. The writer doesn't need to act on it. Making reads visually quiet prevents them from drowning the conversation when the AI reads many documents.

**Key details**:
- BookOpen Phosphor icon (not Wrench), 12px, muted color
- Document names are clickable (opens in doc panel)
- Green check on completion, bouncing gold dots while reading
- 2+ consecutive reads auto-group with count
- No card background -- inline with the conversation flow

### 2. Document Edit (Hero Component)

**Design**: Prominent card with diff preview and accept/reject actions. This is the HIGHEST-VALUE tool call.

```
┌─────────────────────────────────────────────────────────┐
│ ✎ Edited chapter-5.md               Pending Review      │
│   +12 lines, -4 lines, 3 hunks                         │
│                                                          │
│ ┌─ diff ──────────────────────────────────────────────┐ │
│ │ - The jade peaks shimmered faintly in the moonlight │ │
│ │ + The jade peaks blazed with inner fire that pulsed │ │
│ │ + in rhythm with her heartbeat                      │ │
│ │   ...                                               │ │
│ │ - qi flowed through her body                        │ │
│ │ + spiritual energy surged through her meridians     │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                          │
│ [Accept All]  [Reject All]  [Review in Editor →]        │
└─────────────────────────────────────────────────────────┘
```

**States**:
- **Pending Review**: Amber status badge, full diff visible, accept/reject buttons prominent
- **Accepted**: Green left border, green badge, diff faded, undo link
- **Rejected**: Red left border, red badge, diff with red overlay, undo link
- **Partial (mixed)**: Per-hunk accept/reject with individual status indicators
- **Streaming**: Gold shimmer border, diff appearing character-by-character with blinking cursor

**Key details**:
- PencilSimple Phosphor icon (not FileEdit Lucide)
- Warm card background (#F0ECE4 light, slightly warmer than paper)
- 3px left border in status color (amber pending, green accepted, red rejected)
- Diff uses existing DiffPreview component patterns (red strikethrough / green insertion)
- Diff text in Geist Mono 12px; prose content in prose formatting
- Metadata: line counts, hunk count in 11px muted text
- Accept All: jade-teal bg, white text (primary action)
- Reject All: ghost button, border only (secondary action)
- Review in Editor: link-style with ArrowSquareOut icon (opens doc panel with hunks highlighted)
- Connection to collab system: clicking "Review in Editor" sets `pendingProposalId` for auto-selection in the review panel

**Per-hunk review** (inside the diff):
- Each hunk has small Check/X icons on hover
- Accepted hunks get green left border
- Rejected hunks get red left border
- "Accept remaining" / "Reject remaining" for bulk completion

**Multiple edits to same doc**: Grouped under a single doc header with combined stats.
**Multiple docs in one turn**: Each doc gets its own edit card.

### 3. Search Results

**Design**: Clean card with concordance-style result listing.

```
┌──────────────────────────────────────────────────────────┐
│ 🔍 Searched "jade peaks"                     4 matches   │
│                                                           │
│ 📄 chapter-3.md                         Lines 47-49      │
│    ...the jade peaks rose above the clouds...             │
│                                                           │
│ 📄 chapter-5.md                         Lines 12-14      │
│    ...looking down from the jade peaks...                 │
│                                                           │
│ 📄 world-building/geography.md          Lines 8-10       │
│    ...Jade Peaks Mountain Range extends...                │
│                                                           │
│ 📄 character-profiles.md                Lines 156-158    │
│    ...trained at the jade peaks sect...                   │
└──────────────────────────────────────────────────────────┘
```

**Key details**:
- MagnifyingGlass Phosphor icon
- Query text in quotes, match count as rounded pill badge
- Each result: FileText icon + clickable document path + line range
- Snippet text in 12px italic, match term highlighted with warm yellow bg (#F4B41A at 15% opacity)
- Results separated by subtle borders
- Clicking a result opens the document at the matched line in the doc panel
- Collapsed state shows just the header with match count
- Zero results: muted empty state message

### 4. Code/Script Execution

**Design**: Terminal-like display with espresso-tinted output area.

```
┌──────────────────────────────────────────────────────────┐
│ ⌘ word-count analysis                         Success ✓  │
│                                                           │
│ ┌── output ────────────────────────────────────────────┐ │
│ │ Total words: 47,231                                  │ │
│ │ Chapters: 12                                         │ │
│ │ Avg words/chapter: 3,936                             │ │
│ └──────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

**Key details**:
- Terminal Phosphor icon
- Command or description in Geist, not necessarily the raw shell command
- Output area: espresso-tinted bg (#2A2520 or dark mode card-like), Geist Mono 12px
- States: Running (bouncing dots + streaming output), Success (green badge), Error (red badge + error output)
- Output is collapsible if longer than ~8 lines
- Long-running commands show streaming output with blinking cursor

### 5. Grouped Tool Calls (Smart Summary)

**Design**: Replace the generic "N tools" with a type-aware smart summary.

**Collapsed**:
```
┌──────────────────────────────────────────────────────────┐
│ 📖 2  ·  ✎ 1  ·  🔍 1                              ✓ ▾  │
└──────────────────────────────────────────────────────────┘
```

**Expanded**: Each tool shown with its TYPE-SPECIFIC renderer (not generic JSON). Edit cards get visual prominence (jade-teal left border), reads are compact, search results show match count.

**Key details**:
- Category icons with counts, separated by dot dividers
- Icons match the tool type (BookOpen for reads, PencilSimple for edits, MagnifyingGlass for search, Terminal for code)
- Single-line collapsed height (~36px)
- In expanded state, edit sections have visual prominence (left border, warm background)
- The grouping algorithm already exists in `toolGrouping.ts` -- this enhances the GROUP HEADER and per-item rendering

### 6. Streaming State

**Design**: Show a live timeline of the AI's work.

```
BookOpen  Read chapter-3.md                    ✓     ← completed (static, muted)

┌──────── shimmer border ─────────────────────────┐
│ ✎ Editing chapter-5.md...            Writing... │   ← active (gold shimmer)
│   + The jade peaks blazed with inner fire▊      │
└─────────────────────────────────────────────────┘

    Next: searching project...                        ← queued (ghost/dashed)
```

**Key details**:
- Completed tools: static, muted, minimal
- Active tool: gold (#F4B41A) shimmer on border, status text with bouncing dots, streaming content with blinking cursor
- Queued tools: barely visible, dashed border or just muted text
- Below tools: AI text response streaming with amber cursor
- Overall: calm progress, not anxious. "Watching an editor work through your manuscript."

## Design Decisions

### D1: Type-aware rendering over generic rendering

**Decision**: Each tool type gets its own visual renderer instead of a generic JSON display.

**Rationale**: Writers don't think in API calls. "The AI read my chapter" is meaningful. "`str_replace_based_edit_tool({ path: ... })`" is not. The tool registry pattern already supports this -- we register renderers for `Read`, `Grep`, `Glob`, and `bash` alongside the existing `str_replace_based_edit_tool`.

### D2: Visual hierarchy enforces attention priority

**Decision**: Edits are visually prominent (warm card, left border, action buttons). Reads are minimal (single line). Search is medium.

**Rationale**: Edits require writer action (accept/reject). Reads require no action. Visual weight should match required attention. This prevents "tool call fatigue" where every tool looks the same and the writer stops looking.

### D3: Smart summary grouping over generic count

**Decision**: Collapsed group shows "Read 2, Edited 1, Searched 1" with category icons instead of "4 tools".

**Rationale**: "4 tools" tells the writer nothing. "Read 2, Edited 1" tells them the AI consumed context and proposed changes. The summary serves as a micro-narrative of what the AI did.

### D4: Accept/Reject in the chat thread

**Decision**: Accept All / Reject All buttons directly in the chat thread, with "Review in Editor" for deeper review.

**Rationale**: For simple edits, the writer should be able to approve without leaving the conversation. For complex edits spanning multiple hunks, they can open the full review experience in the editor with inline hunk decorations. Two-tier review: quick (in-chat) and deep (in-editor).

### D5: Manuscript marginalia visual metaphor

**Decision**: Tool calls look like editor's annotations on a manuscript, not like developer tools.

**Rationale**: The target user is a fiction writer, not a developer. The paper aesthetic extends to how AI actions are presented. Reads are like marginalia noting "cf. chapter 3". Edits are like tracked changes. Searches are like concordance entries. This reinforces the "serious creative tool" positioning.

### D6: Phosphor icons per tool type

**Decision**: Each tool type uses a specific Phosphor icon instead of the generic Wrench.

| Tool | Icon |
|------|------|
| Document Read | BookOpen |
| Document Edit | PencilSimple |
| Search | MagnifyingGlass |
| Code Execution | Terminal |
| Folder/Structure | FolderOpen |
| Generic/Unknown | Wrench (fallback) |

**Rationale**: Icons communicate tool type instantly. The wrench is generic and doesn't help the writer understand what's happening. Phosphor provides all needed icons in the project's chosen icon set.

### D7: Read collapse threshold

**Decision**: 2+ consecutive reads auto-collapse to "Read N documents" with expandable list.

**Rationale**: The AI often reads 3-5 documents before responding. Showing each read individually takes significant vertical space for zero actionable content. The collapsed form preserves conversation flow while maintaining transparency.

### D8: Match highlighting in search results

**Decision**: Search match terms are highlighted with warm yellow background (#F4B41A at 15% opacity).

**Rationale**: This is the existing "favorite" color in the design system, used for streaming indicators. At low opacity it works as a text highlight without dominating. It helps the writer quickly scan which passages contain their search term.

## Implementation Notes

### Existing Patterns to Leverage

- `toolRegistry.ts`: Register new renderers for `Read`, `Grep`, `Glob`, `bash`
- `CollapsibleToolBlock`: Shared container for all tool blocks
- `ToolStatusBadge` / `ProposalStatusBadge`: Existing badge components
- `DiffPreview`: Existing diff rendering for edits
- `ToolGroupBlock`: Modify header to use smart summary instead of generic count
- `toolGrouping.ts`: Existing grouping algorithm for consecutive tool calls

### New Components Needed

| Component | Purpose |
|-----------|---------|
| `ReadBlock` | Compact document read display |
| `ReadGroupHeader` | "Read N documents" collapsed summary |
| `SearchResultsBlock` | Search results with snippets |
| `BashBlock` | Code execution with terminal-style output |
| `SmartToolGroupHeader` | Type-aware category summary for collapsed groups |

### Migration Path

1. Register `ReadBlock` for tool names: `Read`, `view` (text_editor view command already handled by TextEditorBlock)
2. Register `SearchResultsBlock` for tool name: `Grep`
3. Register `BashBlock` for tool name: `bash`
4. Update `ToolGroupBlock` header to use `SmartToolGroupHeader`
5. Keep `ToolInteractionBlock` as fallback for unknown tools
6. Migrate Wrench icon to appropriate Phosphor icons per type

## SuperDesign References

| Design | Draft ID | Preview |
|--------|----------|---------|
| Full AI Turn (read + think + edit) | `c347c600-ef6e-4ae9-a34d-d121cfa1c98e` | [Preview](https://p.superdesign.dev/draft/c347c600-ef6e-4ae9-a34d-d121cfa1c98e) |
| Document Edit Detail (diff + accept/reject states) | `b57ff024-6c20-47fc-a3f7-56d86212e0ad` | [Preview](https://p.superdesign.dev/draft/b57ff024-6c20-47fc-a3f7-56d86212e0ad) |
| Search Results | `6a8f4bc5-0d22-4b3a-a6ac-347a8a71e351` | [Preview](https://p.superdesign.dev/draft/6a8f4bc5-0d22-4b3a-a6ac-347a8a71e351) |
| Grouped Collapsed vs Expanded | `35b6363b-e0ff-425c-a7a8-f77e508ac602` | [Preview](https://p.superdesign.dev/draft/35b6363b-e0ff-425c-a7a8-f77e508ac602) |
| Streaming State (in-progress) | `e7708abd-1e18-40b6-b226-780cabdc3dc7` | [Preview](https://p.superdesign.dev/draft/e7708abd-1e18-40b6-b226-780cabdc3dc7) |
| Component Map (all variants) | `6d649dff-2c3f-4869-bda4-206bc8b2fa28` | [Preview](https://p.superdesign.dev/draft/6d649dff-2c3f-4869-bda4-206bc8b2fa28) |

## Cross-References

- [Threads Feature](threads.md) -- base chat/thread system
- [Collab v2 Integration](../collab/collab-v2-integration.md) -- proposal/hunk accept/reject system
- [Agent Tools](../agents/agent-tools.md) -- tool definitions (Read, Write, Edit, Grep, Glob, bash)
- [Visual Component Map](../design-system/visual-component-map.md) -- shared UI component reference
- [Brand Foundations](../../foundations/brand.md) -- color, typography, icons
