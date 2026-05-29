# Editor

## What Lives Here

`src/editor/` — 44 files, 15 subdirectories. The CodeMirror 6 document
editor with live preview, session management, and persistence.

| Subsystem | Directory | Key files |
|---|---|---|
| Collab infrastructure | `collab/` | IDB persistence, remote cursors, undo manager |
| React components | `components/` | Editor React components |
| Content utilities | `content/` | Content formatting |
| Decorations (live preview) | `decorations/` | 9 subsystems: headings, emphasis, links, blockquote, lists, HR, images, inline code, fenced code + mermaid (19 files) |
| Export | `export/` | Export utilities |
| Formatting | `formatting/` | Markdown toggle-wrap |
| Interaction | `interaction/` | Context menu, event handlers, menu actions |
| Paste handling | `paste/` | HTML→markdown conversion |
| Persistence | `persistence/` | Editor-level IndexedDB + proposal store |
| Session management | `session/` | DocSession, SessionPool, ViewController, awareness |
| Storybook stories | `stories/` | 10 stories + 4 helpers (simulated server) |
| Title header | `title-header/` | ConnectionStatus, RenameInput, TitleHeader, WordCount |
| Transport | `transport/` | Yjs WS provider |
| Theme | `theme.ts` | Full CM6 theme (312 lines, 70+ CSS classes) |
| Highlight | `highlight.ts` | Lezer syntax highlighting → brand token mapping |
| Live preview composition | `live-preview.ts` | Decoration extension composition |

## Architecture Invariants

These are the hard constraints. Breaking any of them breaks the editorial
experience. See `_docs/design/interaction/editor.md` for the authoritative
design rationale.

### DocSession Owns Y.Doc — NOT EditorView

`DocSession` is the single source of truth per document. It owns:
- `Y.Doc` + `Y.Text("content")`
- `Awareness` (local user presence)
- `Y.UndoManager` (document-level undo stack)
- IndexedDB persistence (`y-indexeddb`)
- WebSocket provider (`transport/`)

`DocSession` **does NOT own `EditorView`**. The view is owned by
`ViewController`. This separation is fundamental — it enables warm
sessions, mirrored surfaces, and the one-view-per-document constraint.

### ViewController Owns EditorView — ≤ 1 Live View per DocSession

`ViewController` manages the `EditorView` lifecycle per rendering surface.
**Hard constraint: at most 1 active (editable) `EditorView` per
`DocSession`.** `attachedViewCount` is always 0 or 1.

When the same document is visible in two surfaces (Studio editor +
Converse editor pane):
- Exactly one surface holds the live editable `EditorView` ("the owner")
- The non-owning surface renders a **read-only projection** of the shared
  `Y.Text` — live, truthful, but not an `EditorView`
- Focusing the non-owning surface **transfers ownership**: the old view is
  destroyed, the new surface creates its view

See `_docs/design/interaction/editor.md` §Surface Ownership & Mirrored
Surfaces for the full contract.

### SessionPool — Warm Sessions Only

`SessionPool` manages document sessions with these rules:
- **Warm budget:** default 10 warm sessions
- **Generation-guarded idle eviction:** only detached sessions (no active
  `EditorView`) are eligible for eviction; sessions with errors are
  ineligible
- **Lease system:** sessions are "leased" to `ViewController` surfsaces
- **Inflight dedup:** inflight create/destroy operations are merged
- **`useSyncExternalStore`-compatible subscription** for React integration

### Live Preview — CM6 Decorations Only

Live preview is built **entirely through CM6 decorations** (StateFields +
ViewPlugins). No shadow DOM. No contenteditable tricks. 9 decoration
subsystems:

- Headings (widget decorations replacing `#` markers)
- Emphasis (mark decorations hiding `**`/`*` markers)
- Links (hide URL, style text as `accent-text`)
- Blockquotes (line decoration: 3px left `accent-fill` border)
- Lists (replace markers with styled bullets/numbers)
- Horizontal rules (widget replacement)
- Images (widget rendering `<img>`)
- Inline code (mark decoration: `muted` bg, `font-mono`)
- Fenced code + Mermaid (block widgets with click-to-edit)

**Reveal mechanism:** syntax markers transition between hidden and revealed:
- Hide: 100ms (`--duration-fast`), `opacity` → 0
- Reveal: 80ms (slightly faster — writer needs syntax quickly)

### Canonical Decoration Layer Ordering (0–7)

This is the single authoritative layer ordering. All other docs reference
this. See `_docs/design/interaction/proposals-review.md` §Decoration Layer
Ordering for the canonical table.

| Layer | Source | Content |
|---|---|---|
| 0 | Lezer | Syntax highlighting |
| 1 | Live preview ViewPlugins | Heading, emphasis, link, blockquote, list, HR, image, inline code |
| 2 | Wiki-link StateField | `[[page]]` decorations |
| 3 | Block StateFields | Fenced code, Mermaid |
| 4 | Proposal StateField | Hunk decorations (insertions, deletions, replacements) |
| 5 | Focus-mode StateField | Paragraph dimming |
| 6 | Selection | Text selection highlight |
| 7 | Collab awareness | Remote cursors + selection ranges |

**Overlap rule:** Higher-numbered layers render on top. Proposal hunks (4)
take visual precedence over live preview (1). Focus-mode dimming (5) sits
between proposals and selection.

### y-codemirror.next — Installed, Not Yet Wired

`y-codemirror.next` is installed (`package.json`) but **not yet wired** to
CM6. The Yjs architecture (DocSession, Awareness, cursor colors) is fully
in place. Wiring it enables real-time collab editing with remote cursors
at layer 7. The wiring point is an `EditorView` extension — do not add it
to `DocSession` (which owns `Y.Doc`, not the view).

## Perf Rules

### Respect CM6's Viewport Model

CM6 only renders the visible portion of the document. Block-height and
geometry changes go through `requestMeasure`, never eager DOM mutation.
Do not force a full-document re-render.

### INP Budget: ≤ 200 ms

The Interaction to Next Paint budget is ≤ 200 ms. Interaction callbacks
must be short; heavy work goes off the main thread. No synchronous
reflow-reads after writes within the same task. See
`_docs/design/foundations/motion.md` §INP Budget.

### `content-visibility` for Long Transcripts

Scrollable editor surfaces use `content-visibility: auto` to reduce
rendering cost for off-screen portions. See
`_docs/design/foundations/motion.md` §content-visibility.

### Touch/Mobile: Preserve Native Selection

On mobile, the CM6 editor preserves native text selection — no custom
selection handles, no `touch-action: none` on the editor surface, no DOM
mutations while selection is active. See `_docs/design/interaction/editor.md`
§Touch & Mobile Editing for the full touch editing spec.

## Design Spec Pointers

| Concern | Canonical doc |
|---|---|
| Editor architecture, live preview, formatting toolbar, focus mode, touch editing, surface ownership | `_docs/design/interaction/editor.md` |
| Decoration layer ordering (canonical 0–7) | `_docs/design/interaction/proposals-review.md` §Decoration Layer Ordering |
| Proposals review (hunks, review toolbar, document-level undo) | `_docs/design/interaction/proposals-review.md` |
| Keyboard map (editor shortcuts, formatting) | `_docs/design/interaction/navigation.md` §Full Keyboard Map |
| Motion tokens, INP budget, `content-visibility` | `_docs/design/foundations/motion.md` |
| Type scale, editor typography | `_docs/design/foundations/typography.md` |
| Color (accent-fill vs accent-text rule, link color) | `_docs/design/foundations/color.md` |
| Editor focus treatment | `_docs/design/interaction/editor.md` §Editor Focus Treatment |
