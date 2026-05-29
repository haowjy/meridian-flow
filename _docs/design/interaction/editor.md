# Editor

The CodeMirror 6 document editor with live preview, formatting, and the
decoration-layer system. The editor is the primary surface in Studio and a
secondary surface in Converse.

---

## Live Preview

Meridian uses an Obsidian-style live preview: markdown syntax is hidden when
the cursor is on a different line, and revealed when the cursor enters the
line. This lets the writer see formatted output while writing raw markdown.

### Decoration Architecture

Each syntax type has its own **ViewPlugin** or **StateField** that produces
an independent `DecorationSet`. CM6 merges all sets automatically. This
architecture is already built (19 files in `editor/decorations/`).

| Syntax | File | Technique |
|---|---|---|
| Headings | `heading.ts` | Widget decoration replacing `#` markers with styled text |
| Emphasis | `emphasis.ts` | Mark decoration hiding `**`/`*`/`__`/`_` markers |
| Links | `links.ts` | Hide URL portion, style text as clickable (`accent-text`) |
| Blockquotes | `blockquote.ts` | Line decoration: 3px left border (`accent-fill`), italic, `muted-foreground` |
| Lists | `lists.ts` | Replace markers (`-`/`*`/`1.`) with styled bullets/numbers |
| Horizontal rules | `horizontal-rule.ts` | Widget replacement for `---`/`***` → styled `<hr>` |
| Images | `images.ts` | Widget rendering `<img>` from `![]()` |
| Inline code | `inline-code.ts` | Mark decoration: `muted` bg, `font-mono`, 0.9em |
| Fenced code | `fenced-code-widget.ts` | Block widget: `muted` bg, `font-mono`, 0.92em, language label, copy button |
| Mermaid | `mermaid-widget.ts` | Block widget: rendered diagram |
| Block composition | `block-decorations.ts` | Unified StateField for fenced code + mermaid (must be StateField for multi-line) |

### Reveal Mechanism

When the cursor enters a line with hidden syntax:

1. The syntax markers (e.g., `#`, `**`) transition from `opacity: 0` to
   `opacity: 1`
2. **Reveal:** 80ms transition (fast — the writer needs to see the syntax
   quickly)
3. **Hide:** 100ms transition (slightly slower — gentle disappearance as the
   cursor leaves)

CSS classes:
- `.md-hidden-syntax` — `opacity: 0`, `transition: opacity 100ms`
- `.md-revealed` — `opacity: 1`, `transition: opacity 80ms`

The asymmetry (fast reveal, slow hide) is intentional — the writer is more
likely to be frustrated by delayed syntax access than by delayed cleanup.

### Block Rendering (Click-to-Edit)

Fenced code blocks and mermaid diagrams use a click-to-edit pattern:

| State | Display |
|---|---|
| Default | Rendered widget (syntax-highlighted code or diagram) |
| Clicked / cursor enters | Raw markdown revealed — the widget is replaced by the text content |
| Cursor leaves the block | Rendered widget again |

This keeps the reading experience clean while still allowing direct editing.

### Wiki-Links (Carried Forward from v1)

> **Decision:** Wiki-link support (`[[page]]` syntax) carries forward to v2.
>
> **Rationale:** Wiki-links are a core navigation mechanism for fiction writers
> linking between chapters, characters, locations, and lore entries. Removing
> them would be a feature regression.

Wiki-link decorations:
- `[[page]]` renders as a styled link (hide `[[` and `]]` syntax, `accent-text`
  color, underlined)
- Hover shows a tooltip with the linked page's title
- Click navigates to the linked document (opens in Studio tab)
- Broken links (page doesn't exist) show `destructive` color with a
  dashed underline
- `Mod+Click` on a broken link offers a "Create page" action

Wiki-link support adds a decoration layer at **layer 2** in the canonical
layer ordering (between live preview and block rendering). See
`interaction/proposals-review.md` §Decoration Layer Ordering for the
single canonical layer table. It uses Mark decorations for
the `[[...]]` syntax.

---

## Formatting Toolbar

A floating toolbar that appears when text is selected, providing quick
formatting actions.

| Property | Value |
|---|---|
| Trigger | Text selection (≥ 1 character) |
| Position | Floating above the selection, horizontally centered |
| Delay | 150ms after selection stabilizes (avoid flicker on click-drag) |
| Background | `card` |
| Border | 1px `border`, `radius-lg` |
| Shadow | `--elevation-overlay` |
| Padding | `4px` |

### Toolbar Actions

| Action | Icon | Shortcut | Markdown |
|---|---|---|---|
| Bold | Phosphor `TextB` | `Mod+B` | `**text**` |
| Italic | Phosphor `TextItalic` | `Mod+I` | `*text*` |
| Code | Phosphor `Code` | `Mod+E` | `` `text` `` |
| Link | Phosphor `Link` | `Mod+K` | `[text](url)` |
| H1 | "H1" text | `Mod+1` | `# text` |
| H2 | "H2" text | `Mod+2` | `## text` |
| H3 | "H3" text | `Mod+3` | `### text` |
| List | Phosphor `ListBullets` | `Mod+Shift+L` | `- text` |
| Quote | Phosphor `Quotes` | `Mod+Shift+Q` | `> text` |

**Behavior:**
- Icons are 18px, `muted-foreground` color, `accent-fill` on hover
- Active state (text already formatted): icon uses `accent-fill` color
- Toggle behavior: clicking Bold on bold text removes bold
- Separator between text formatting (B/I/Code/Link) and block formatting
  (H1-H3/List/Quote)

### Relationship to Keyboard Shortcuts

The toolbar is a discovery mechanism for keyboard shortcuts. Power users will
use shortcuts directly. The toolbar shows the shortcut on hover tooltip.

> **Decision:** The formatting toolbar is additive — it supplements keyboard
> shortcuts, not replaces them. All formatting actions remain available via
> keyboard regardless of whether the toolbar is visible.

---

## Editor Theme

The CM6 theme (existing: `editor/theme.ts`, 312 lines) defines the visual
treatment of the editor surface.

### Key Theme Properties

| Property | Value | Token |
|---|---|---|
| Font family | iA Writer Quattro | `--font-editor` |
| Font size | `--editor-font-size` | clamp(1rem, 0.95rem + 0.2vw, 1.125rem) |
| Line-height | `--editor-leading` | 1.65 |
| Content padding | 1.5rem 1.75rem | (existing) |
| Active line highlight | `foreground` at 4% opacity | `color-mix(in oklab, var(--foreground) 4%, transparent)` |
| Gutter | Transparent, borderless | (existing) |
| Focus outline | None | (existing — `.cm-focused { outline: none }`) |
| Cursor | `foreground` color, 2px width | — |
| Selection | `accent-fill` at 20% opacity | — |
| Matching brackets | `accent-fill` at 15% opacity | — |

### Syntax Highlighting

Lezer tags mapped to Meridian tokens (existing: `editor/highlight.ts`):

| Tag | Color | Weight |
|---|---|---|
| `heading` | `foreground` | 700 |
| `link`, `url` | `accent-text` | 400, underlined |
| `emphasis` | `foreground` | 400, italic |
| `strong` | `foreground` | 700 |
| `monospace` | `foreground`, subtle bg | 400, `font-mono` |
| `comment` | `muted-foreground` | 400 |
| `keyword` (in code) | `accent-text` | 500 |

**Link/URL rule:** All link and URL text — in BOTH live preview and syntax
highlighting — uses `accent-text`. The `accent-fill` token is never used for
text. This keeps the accent-text rule simple and auditable: any teal-colored
text = `accent-text`.

### Editor Focus Treatment

> **Decision:** The CM6 editor surface removes the inner outline
> (`.cm-focused { outline: none }`). The keyboard-focus affordance is
> provided on the **editor frame/header container** instead — a `3px`
> `--ring` at 50% opacity ring on the editor container's border on
> `:focus-visible`.
>
> **Rationale:** An outline inside the text surface interferes with
> reading and writing. Placing the focus ring on the editor frame provides
> the same accessibility benefit without intruding on the prose.
>
> **Interaction:** When the editor has focus (keyboard or click), the
> frame ring appears. When focus moves to another element (toolbar, sidecar
> composer), the ring disappears. The CM6 cursor and selection decorations
> remain visible regardless of focus state.

### Bottom Padding

The editor has 40vh of transparent bottom padding (existing). This lets the
writer keep their active line at a comfortable eye level without scrolling to
the absolute bottom. This is a common pattern in writing apps.

---

## Focus Mode

Focus mode provides a distraction-free writing experience. It is in scope
for v2 (confirmed 2026-05-29).

### Core (Required)

| Change | Focus mode behavior |
|---|---|
| Rail | Hidden (0 width) |
| File explorer | Hidden |
| Chat sidecar | Hidden |
| Status bar | Hidden |
| Tab bar | Hidden (only one document visible) |
| Editor | Full viewport width, content still constrained to `--editor-measure` (68ch), centered |
| Toggle | `Mod+Shift+\` |
| Exit | `Escape` or `Mod+Shift+\` again |

### Paragraph Dimming (Optional Refinement)

An optional CM6 decoration that dims non-cursor paragraphs to
`muted-foreground` at 40% opacity, making the current paragraph visually
prominent. This is slotted into the canonical decoration layer order at
**layer 5** (between proposal hunks and selection). See
`interaction/proposals-review.md` §Decoration Layer Ordering for the
single canonical layer table.

| Property | Value |
|---|---|
| Dimmed paragraphs | `muted-foreground` at 40% opacity |
| Transition | `duration-moderate` (200ms), `ease-default` |
| Respects | `prefers-reduced-motion` — instant if reduced |
| Cursor movement | The dimmed region updates as the cursor moves between paragraphs |

*Evidence: iA Writer's focus mode dims everything except the current sentence
or paragraph. This is the gold standard for focus in writing tools
(design-language-best-practices §5).*

Focus mode is purely a CSS state + optional CM6 decoration — no components
are unmounted. The writer's scroll position, cursor position, and all other
state survive entering and exiting focus mode.

---

## Touch & Mobile Editing

How the CM6 editor behaves on touch devices. The core principle: **preserve
native text behavior, minimize custom DOM during selection and composition,
and make the keyboard a first-class viewport concern.**

*Evidence: mobile-touch-editing.md — the common failure mode across CM6,
ProseMirror, and Lexical is too much custom DOM or event logic during an
active selection or IME composition. The safest mobile editor changes the
DOM the least during typing.*

### Native Selection Preservation

> **Decision:** The CM6 editor preserves native text selection on touch
> devices. No custom selection handles, no custom long-press behavior on
> editable text, no broad `touch-action` disabling on the editor surface.
>
> **Rationale:** Native selection provides system drag handles, native
> copy/paste toolbars, IME compatibility, platform gestures, and correct
> accessibility behavior. Custom selection systems invariably lose some of
> these and create maintenance burden across iOS/Android/browser combinations.
>
> **Rejected:** Custom selection rendering (breaks IME, loses platform
> handles). Broad `touch-action: none` on the editor (breaks scroll and
> selection gestures).
>
> *Evidence: mobile-touch-editing.md §1 — "Do not replace native selection
> with a custom selection system unless you absolutely have to."*

Rules for preserving native selection:

1. **No `preventDefault()` on touch events** in the editable region unless
   there is a narrow, documented reason.
2. **No overlays that intercept taps** on top of editable text. Floating
   menus (formatting toolbar, hunk widget) anchor outside the selection
   region and appear only after selection stabilizes.
3. **`touch-action` is applied only to non-editor chrome** (drawer handles,
   resize handles, swipe surfaces). The editor surface uses the browser's
   default touch-action.
4. **No DOM mutations while selection is active.** Decoration updates that
   would redraw the active selection region are deferred until the selection
   drag ends. This prevents iOS handle disappearance and Android handle
   churn.
5. **Keep the editor's ancestor chain simple.** Avoid CSS transforms on
   editor ancestors (breaks tooltip and selection geometry on iOS).

### AccessoryBar (Formatting Above the Keyboard)

On Phone and Tablet without a hardware keyboard, the AccessoryBar replaces
the floating formatting toolbar. It sits above the virtual keyboard and
provides contextual, selection-local actions.

See `components.md` §AccessoryBar for the component spec.

**When it appears:**
- When the CM6 editor has focus and the virtual keyboard is visible.
- Hides when the editor loses focus or the keyboard dismisses.

**Default actions (editing context):**

| Position | Action | Icon |
|---|---|---|
| 1 | Bold | `TextB` |
| 2 | Italic | `TextItalic` |
| 3 | Link | `Link` |
| 4 | Heading cycle (H1→H2→H3→paragraph) | `TextH` |
| 5 | List toggle | `ListBullets` |
| 6 | Code | `Code` |
| 7 | More (overflow) | `DotsThree` |

**Overflow actions (in a scrollable row or bottom sheet):**
- Quote, Checklist, Horizontal rule, Undo, Redo, Image insert

**Review context (cursor in a hunk):**

When the cursor is inside a proposal hunk, the AccessoryBar switches to
review actions:

| Position | Action | Icon |
|---|---|---|
| 1 | Keep | `Check` (success tint) |
| 2 | Edit | `PencilSimple` |
| 3 | Discard | `X` (destructive tint) |
| 4 | Previous hunk | `CaretLeft` |
| 5 | Next hunk | `CaretRight` |
| 6 | Hunk counter | Text: "2/5" |

This context switch is automatic — the AccessoryBar detects whether the
cursor is inside a hunk decoration and swaps its action set.

### Keyboard-as-Viewport

The virtual keyboard is a viewport concern, not just an input concern.
The editor must actively manage the visible area when the keyboard is open.

**Caret keeping:**
- When the keyboard opens, the editor scrolls to keep the caret visible
  above the keyboard + AccessoryBar.
- Uses `scrollIntoView({ block: "nearest" })` with a threshold that
  ensures at least 2 lines of context above the caret.
- Scroll adjustments are minimal — avoid yanking the viewport. Only scroll
  enough to keep the caret visible.

**Shell sizing:**
- The editor shell uses `100dvh` (via the app shell) as the base height.
- The inner scroll region accounts for: BottomNav height (when keyboard
  is hidden), keyboard height (when keyboard is open), AccessoryBar height,
  and safe-area insets.
- Uses `visualViewport.height` (or `navigator.virtualKeyboard.boundingRect`
  on Chromium) to determine available space above the keyboard.

**Bottom padding:**
- The existing 40vh bottom padding (for keeping the active line at
  comfortable eye level) remains on mobile. It may need to be reduced
  to 20vh on Phone to save memory and reduce oversized scroll ranges.

### Focus Writing as Phone Default

> **Decision:** On Phone, the editor defaults to a reduced-chrome state
> that hides non-essential UI while typing. This is distinct from the
> explicit Focus Mode (which is a user-toggled state).
>
> **Rationale:** On a phone screen, every pixel matters. The keyboard
> already consumes ~40% of the viewport. Showing the full TabBar, editor
> header, and all chrome while typing wastes the remaining space. The
> strongest mobile writing apps (iA Writer, Ulysses, Bear) hide chrome
> during typing by default.
>
> *Evidence: mobile-touch-editing.md §5 — "make focus-writing mode the
> default on phones."*
>
> **Rejected:** Keeping all chrome visible on phone (wastes space, conflicts
> with the "prose is the product" principle). Making explicit Focus Mode
> the phone default (Focus Mode hides the BottomNav and all navigation,
> which would trap the writer).

Phone auto-focus behavior:
- **When the keyboard opens:** TabBar fades to a compact single-line
  indicator (active tab name only, `text-xs`). The editor header shrinks
  to a minimal strip (document title only, no word count while typing).
- **When the keyboard closes:** Full TabBar and editor header restore.
- **BottomNav stays visible** (unlike explicit Focus Mode, which hides
  it). The writer always has a way to navigate.
- **Explicit Focus Mode (`Mod+Shift+\`) is still available** on tablet
  with keyboard — it hides the BottomNav/Rail and all secondary panes,
  same as desktop.

### Wiki-Links on Touch

- **Tap** a wiki-link to navigate to the linked document (same as click
  on desktop).
- **Long-press** a wiki-link to show a preview tooltip with the linked
  page's title and a "Open" / "Create" action for broken links.
- `Mod+Click` (broken link → Create page) has no direct touch equivalent;
  the long-press action provides the same functionality.

### Formatting Without a Hardware Keyboard

All formatting is available through the AccessoryBar (see above). The
floating formatting toolbar (appears on text selection on desktop) is
**not shown on Phone** — it would overlap with the native selection
handles and copy/paste toolbar. On Tablet, the floating toolbar appears
on selection only when a hardware keyboard is connected (no AccessoryBar
visible).

---

## Editor in Converse vs. Studio

| Property | Converse | Studio |
|---|---|---|
| Position | Right pane, secondary | Center, primary |
| Tab bar | None (single doc, name in header) | Full tab bar |
| File explorer | None | Left sidebar |
| Formatting toolbar | Same | Same |
| Proposal hunks | Same decorations | Same decorations |
| Review toolbar | Same floating toolbar | Same floating toolbar |
| Sidecar/chat | N/A (chat is the other pane) | Right sidecar |
| Focus mode | Not available (editor is secondary) | Available |
| `--editor-measure` | 68ch (may be constrained by pane width) | 68ch |

---

## Surface Ownership & Mirrored Surfaces

### Ownership Model

- **`DocSession`** owns the document state — the `Y.Doc` / `Y.Text("content")`,
  awareness, undo, and IndexedDB persistence. One session per document; the
  single source of truth.
- **`ViewController`** owns the editable `EditorView` **per surface**.
- **Hard constraint:** at most **one live (editable) `EditorView` per
  DocSession** (`attachedViewCount` is `0` or `1`). This is enforced in code
  and must not be contradicted anywhere in the spec.

> **Decision:** When the same document is visible in two surfaces at once (e.g.
> the Studio editor and the Converse editor pane), exactly one surface holds the
> live editable `EditorView` ("the owner"). The **non-owning surface renders a
> live read-only projection** of the shared `Y.Text` — it reflects edits in real
> time (driven by the shared `Y.Doc`) but is not itself an `EditorView`, so the
> one-view-per-session constraint is preserved. Acquiring edit intent on the
> non-owning surface — focusing it or starting to type — **transfers ownership**:
> the live view moves to that surface and the previously-owning surface drops to
> the read-only projection.
>
> **Rationale:** A writer expects to *see* their prose in every pane that shows
> the document; a blank or frozen pane is jarring in a writing tool. A read-only
> projection is cheap (a render of the shared text, no second view, no second
> awareness presence) and keeps both panes truthful. Transfer-on-focus matches
> the ownership-transfer path already implemented and tested in
> `ViewController` (`transfers lease across surfaces…`).
>
> **Rejected:** (a) Two live `EditorView`s — violates the one-view constraint and
> doubles awareness/undo complexity. (b) A blank "Open in Studio — click to edit
> here" placeholder — needs no new rendering but hides the writer's own prose,
> which is the opposite of the product's posture.

### Supporting Rules

- The read-only projection updates live from the shared `Y.Doc`; it shows no
  text cursor and publishes no awareness presence.
- Ownership transfer is the `ViewController` lease-transfer path: on transfer
  the old surface's view is destroyed, the new surface creates its view, and
  cursor awareness is cleared on the surface losing the view and (re)published
  on the surface gaining it.
- Only one surface ever shows a text cursor / contributes awareness for a given
  document at a time.

### Appendix: Why Mirrored Surfaces

When the same document is visible in two surfaces at once — the Studio editor
and the Converse editor pane — the system must present consistent, live prose
in both panes without violating the architectural constraint that a
`DocSession` supports at most one live `EditorView`. The read-only projection
on the non-owning surface achieves this: it renders directly from the shared
`Y.Text`, so edits made on the owning surface appear immediately on the
non-owning surface without a second `EditorView`, a second awareness presence,
or a second undo history.
