---
detail: standard
audience: developer, architect
---
# Research Notes: Collab v2 Landscape

Research and competitive analysis informing the collab v2 design decisions. Captured March 2026.

## Competitive Landscape

### Fiction AI Writing Tools

| Product | Editor | AI Model | Suggestion UX | Collab | Context System |
|---------|--------|----------|---------------|--------|---------------|
| **Sudowrite** | Custom | Muse 1.5 (fine-tuned on fiction) | Sidebar cards, one-click insert | None | Story Bible (upload 2k-word sample for voice training) |
| **Novelcrafter** | Rich text | BYOK (OpenRouter, OpenAI, local) | Workshop Chat, in-text editing | None | **Codex** -- structured wiki with auto-linking and progressions |
| **NovelAI** | Minimal | Kayra (proprietary) | Inline autocomplete | None | Lorebook (keyword-triggered context injection) |

**Key insight: no fiction tool has real-time collaboration.** All are single-user. None offer inline diff accept/reject for AI edits. Meridian's proposal model is novel in this space.

**Novelcrafter's Codex** is the most sophisticated context system -- structured entries for characters, locations, lore with auto-detection in manuscript text and "progressions" tracking how elements change across chapters. Meridian's approach is more flexible: free-form files + templates + skills + system prompts define how context gets assembled, similar to Claude Code's CLAUDE.md model. More powerful, less prescriptive.

### Collaborative AI Editors (general)

| Product | AI Suggestion Pattern |
|---------|----------------------|
| Google Docs AI | Sidebar "Help me write" -- outputs inserted as new text, no review UX |
| Notion AI | Inline replacement or "insert below" -- no track-changes style |
| Cursor (code) | Ghost text for completions (Tab), inline diffs for edits (accept/reject) |
| GitHub Copilot | Ghost text completions, no structural edits |

### Collaborative Markdown Editors (no AI)

| Project | Stack | Notes |
|---------|-------|-------|
| HedgeDoc | CM6, v2 rewrite in progress | Open source, no AI, no live preview |
| ink-mde | CM6 + TypeScript | Open source markdown editor, no collab |
| Obsidian | CM6 with ViewPlugin live preview | Closed source, community AI plugins (chat sidebar only) |

### Gap Meridian Fills

No existing product combines: real-time Yjs collab on markdown + inline AI proposals with accept/reject/undo + fiction-aware context assembly + Obsidian-style live preview + review comments alongside proposals.

## CRDT and Collaborative Editing Research

### "Lies I Was Told About Collaborative Editing" (Conference Talk)

Source: `temp/talk.txt` -- talk by a developer building a Notion/Google Docs-like rich text editor.

Key findings that validate v2 design:

1. **Direct editing conflicts are perceived as data corruption.** In user testing, 100% of users viewed CRDT auto-reconciliation results as corruption. Example: Alice deletes a paragraph, Bob edits a word in it -- CRDT produces just the letter "U". Users asked "why did you corrupt my data?"

2. **This is a UX problem, not an algorithms problem.** No algorithm can auto-merge conflicting edits in a way that makes sense to non-technical users. Solutions: presence indicators (help users avoid conflicts), domain modeling (reduce conflict surface area), diff-based resolution UIs.

3. **60fps is surprisingly hard.** With 10+ concurrent readers/writers, Yjs/ShareJS consume significant CPU on the render thread. Every update must fit in 16ms. Server must batch/chunk changes for broadcast.

4. **Collaborative text editing is a database problem.** Clients send transactions to a server. The server detects conflicts, broadcasts results. Recommends single-leader architecture (Cloudflare Durable Objects, etc.) over pure P2P.

**Validation for v2:** Per-user projection avoids corruption perception. Server-authoritative Yjs aligns with single-leader recommendation. Debounced re-derive (50-100ms) addresses batching concern.

### Peritext (Ink & Switch, 2022)

CRDT algorithm for rich text formatting. Key insights:

- Formatting spans attach to character IDs via "anchors" (before/after positions), not indices
- Determines whether inserted text inherits formatting (bold grows, links don't)
- **Comments are non-mutually-exclusive marks** -- multiple comments can overlap on same text, unlike formatting which conflicts (can't be both red and blue)
- Published in ACM PACMHCI, Volume 6, CSCW2

**Relevance:** Validates that annotations (comments) need different semantics than text operations. Our design puts comments in a separate `Y.Array` with `Y.RelativePosition` anchors, which is the right separation.

### Loro

Newer CRDT library (Rust + WASM). Implements Peritext + Fugue (minimizes interleaving anomalies). Potentially better performance than Yjs for rich text. Less mature ecosystem. Worth watching, not worth switching.

### Eg-walker (EuroSys 2025)

Collaboration algorithm using "an order of magnitude less memory" than existing CRDTs. Document loading "orders of magnitude faster." Academic research, not production-ready.

### "Collaborative Text Editing Without CRDTs or OT" (Matthew Weidner, 2025)

Alternative approach: assign unique IDs to each character, use "insert after [ID]" operations with server reconciliation. Conceptually simpler than CRDTs but requires server as source of truth. Our architecture already follows this pattern -- server-authoritative with Yjs as the CRDT layer.

## Technical Ecosystem

### CM6 Extensions of Interest

| Extension | What it does | Relevance |
|-----------|-------------|-----------|
| `@marimo-team/codemirror-ai` | Inline AI completions + accept/reject for CM6 | Reference implementation for prediction engine (future) |
| `y-codemirror.next` | Yjs binding for CM6 | Already using |
| Obsidian's ViewPlugin | Live preview via decoration hiding | Our live preview follows the same pattern |

### DOCX/PDF Conversion

| Library | Direction | Notes |
|---------|-----------|-------|
| mammoth.js | DOCX to HTML | Markdown output deprecated; use mammoth + turndown.js instead |
| turndown.js | HTML to Markdown | Pair with mammoth for DOCX import |
| pandoc | Any to any (CLI) | Best for export: markdown to DOCX/PDF with templates |
| docx.js | Generate DOCX programmatically | Alternative to pandoc for server-side export |

### Tiptap Comments (reference)

Tiptap's comment extension uses ProseMirror marks + cloud API + webhooks. Comments are a paid feature tied to their collaboration cloud. Our approach using `Y.RelativePosition` in a `Y.Array` is more self-contained and decoupled from the editor framework.

## Future Features (out of v2 scope)

These emerged from research but belong in separate plans:

| Feature | Notes | Where to plan |
|---------|-------|---------------|
| Prediction engine (ghost text) | Fast model, ~200ms latency, Tab to accept. Completely separate from proposals. `@marimo-team/codemirror-ai` as reference. | `_docs/plans/` |
| Context assembly (templates + skills) | Programmable codex -- writer defines how AI context is assembled. Claude Code / CLAUDE.md model. | `_docs/high-level/` or `_docs/features/` |
| Sidebar suggestions UI | AI-generated alternative rewrites shown as cards. Could share UI with review comments. | `_docs/features/` |

## v2 Architectural Limits

What would be extremely hard or require a v3 rearchitecture:

| Feature | Constraint | Severity |
|---------|-----------|----------|
| Structured document model as canonical (Notion-style blocks) | Y.Text is flat string, not a tree | Would require v3 |
| Native DOCX editing (not import/export) | Markdown can't represent DOCX structure faithfully | Would require v3 |
| Tables as first-class editable structures | Markdown tables are text; cell merge, formulas don't map | Very hard |
| Cell/block-level permissions | Y.Text has no range-level access control | Awkward (app-layer enforcement) |
| Block-level drag/drop reordering | Text cut+paste, not tree operation; needs transaction grouping | Hard but doable |

**Conclusion:** As long as markdown-as-text remains canonical, v2 handles everything on the current roadmap. The only trigger for v3 would be needing a structured document model as canonical.

## Sources

- [Sudowrite Review 2026](https://nerdynav.com/sudowrite-review/)
- [Novelcrafter Features](https://www.novelcrafter.com/features)
- [Novelcrafter Codex](https://www.novelcrafter.com/features/codex)
- [Peritext: A CRDT for Rich-Text Collaboration](https://www.inkandswitch.com/peritext/)
- [Collaborative Text Editing without CRDTs or OT](https://mattweidner.com/2025/05/21/text-without-crdts.html)
- [Eg-walker (EuroSys 2025)](https://dl.acm.org/doi/10.1145/3689031.3696076)
- [Loro Rich Text CRDT](https://loro.dev/blog/loro-richtext)
- [y-codemirror.next](https://github.com/yjs/y-codemirror.next)
- [@marimo-team/codemirror-ai](https://github.com/marimo-team/codemirror-ai)
- [Tiptap Comments](https://tiptap.dev/docs/comments/getting-started/overview)
- [Which Rich Text Editor in 2025 (Liveblocks)](https://liveblocks.io/blog/which-rich-text-editor-framework-should-you-choose-in-2025)
- [GenAI UX Patterns](https://uxdesign.cc/20-genai-ux-patterns-examples-and-implementation-tactics-5b1868b7d4a1)
- [Obsidian CM6 Migration Guide](https://obsidian.md/blog/codemirror-6-migration-guide/)
- [Best AI for Writing Fiction 2026](https://blog.mylifenote.ai/the-11-best-ai-tools-for-writing-fiction-in-2026/)
