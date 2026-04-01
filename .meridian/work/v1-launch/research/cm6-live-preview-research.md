# CM6 Live Preview / WYSIWYG Markdown Research

Date: 2026-03-21

## Scope and note on tooling
- Requested `context7` lookup is not possible in this harness (`context7: command not found`), so this research uses primary sources directly (CodeMirror docs/examples + OSS repos).

## Executive summary
- Build live preview with **syntax-tree-driven decorations**, not regex-only parsing.
- Use a **hybrid architecture**:
  - `StateField` (direct decorations) for block-level replacements that affect layout (images, code blocks, mermaid, tables, hr blocks, large widgets).
  - `ViewPlugin` (indirect decorations, viewport-limited) for inline cosmetic transforms (hiding `**`, `_`, link punctuation, heading markers).
- Keep markdown as source of truth; never mutate rendered DOM directly.
- Use cursor-aware reveal rules: if selection intersects node/line, show raw markdown for that region.
- For clickable widgets/links, explicitly control events (`ignoreEvent`, `mousedown`, `preventDefault`, `stopPropagation`).
- Performance at 1000+ lines depends on avoiding full-doc recompute on every update. Restrict work to `visibleRanges` where possible and map previous ranges through changes when possible.

## Current Meridian frontend-v2 context (important)
From local files:
- `frontend-v2/src/editor/Editor.tsx` currently sets up `markdown()` + theme + highlight + history/keymap.
- `frontend-v2/src/editor/highlight.ts` already styles heading/bold/italic/link/mono/quote/list tags.
- `frontend-v2/src/editor/theme.ts` provides base CM theme styling.

Implication:
- You already have parser/highlight. Missing piece is a **live preview extension layer** (decorations/widgets + event handling + block rendering pipeline).

## Official CM6 APIs (what matters)

### Decorations API
- Decoration types: mark, widget, replace, line.
- `Decoration.replace` is the core for hiding markdown syntax or replacing ranges with widgets.
- Block replacements (`block: true`) and any vertical-layout-changing decorations must be provided directly (not via viewport callback).
- Source:
  - https://codemirror.net/examples/decoration/
  - https://codemirror.net/docs/ref/#view.Decoration

### `WidgetType` and `ignoreEvent`
- Widgets are lightweight descriptors; CM can reuse DOM via `eq`/`updateDOM`.
- `ignoreEvent` controls whether CM consumes events from widget DOM.
- Use `estimatedHeight` (+ `requestMeasure` when dynamic height changes) for stable layout/scroll behavior.
- Source:
  - https://codemirror.net/docs/ref/#view.WidgetType
  - https://codemirror.net/docs/ref/#view.Decoration

### `ViewPlugin` vs `StateField` for decorations
- CM guidance: use `ViewPlugin` for viewport-driven/derived behavior; `StateField` for durable/editor-state-coupled behavior and decorations that can affect viewport/layout.
- Only direct decoration sources can safely affect block structure.
- Sources:
  - https://codemirror.net/docs/guide/#decorating-the-document
  - https://codemirror.net/examples/decoration/
  - Obsidian CM6 plugin docs distillation: https://docs.obsidian.md/Plugins/Editor/Decorations

### `EditorView.theme`
- Use `EditorView.theme({...})` for scoped editor theming.
- Use `&` selector for the editor wrapper (`&.cm-focused`, etc.).
- Sources:
  - https://codemirror.net/docs/ref/#view.EditorView^theme
  - https://codemirror.net/examples/styling/

## Real CM6 live-preview implementations

## 1) SilverBullet (CM6, Obsidian-style live preview)
- Repo: https://github.com/silverbulletmd/silverbullet
- Live-preview docs page: https://silverbullet.md/Live%20Preview
- Key code patterns:
  - Cursor-aware syntax hiding (`hide_mark.ts`): hide emphasis/code/header markers unless cursor is inside node.
  - Link rendering (`link.ts`): hide `[]()` punctuation and mark visible label as `<a>`.
  - Image rendering (`inline_content.ts`): parse markdown image/transclusion and replace with block widget.
  - Horizontal rule (`block.ts`): hide source token and add line decoration class.
  - Tables (`table.ts`): replace table block with widget + cached widget height (`estimatedHeight`).
  - Fenced code custom widgets (`fenced_code.ts`) + sandbox iframe (`iframe_widget.ts`).
  - Utility `decoratorStateField` includes IME-specific optimization (`input.type.compose`) to avoid expensive full recompute during composition.
- Why useful:
  - Production-like, markdown-source-first architecture with many edge-case behaviors handled.

## 2) `codemirror-rich-markdoc` (CM6 rich markdown)
- Repo: https://github.com/segphault/codemirror-rich-markdoc
- Pattern:
  - Uses `ViewPlugin` for inline token hiding/styling in visible ranges (`richEdit.ts`).
  - Uses `StateField` + `Decoration.replace({block: true})` for structural block replacement (`renderBlock.ts`).
- Valuable notes:
  - README explicitly lists known issues: cursor navigation into replaced blocks, full recompute cost, click-position mismatch.
- Why useful:
  - Clean separation of inline vs structural rendering responsibilities.

## 3) `codemirror-markdown-hybrid` (CM6 line-level hybrid preview)
- Repo: https://github.com/tiagosimoes/codemirror-markdown-hybrid
- Discussion thread: https://discuss.codemirror.net/t/hybrid-markdown-editing-preview-for-unfocused-lines-raw-for-active-line/9660
- Pattern:
  - `ViewPlugin` replaces unfocused lines with rendered widgets.
  - `StateField`s for block structures (code/table/math) where line ranges need coordinated handling.
  - Focus effect dispatch and line-focused reveal logic.
- Caveats found in code:
  - Relies heavily on string/regex block detection; less robust than syntax-tree-first parsing.
  - README claims mermaid support, but current source shows no mermaid implementation in `src/`.

## 4) Obsidian references
- Live Preview announcement/changelog:
  - https://obsidian.md/blog/live-preview-update/
  - https://obsidian.md/changelog/2021-12-09-desktop-v0.13.8/
- CM6 API guidance for plugin authors:
  - https://docs.obsidian.md/Plugins/Editor/Decorations
- Important practical point:
  - Obsidian core CM6 implementation is not open source; use docs + ecosystem behavior as external signal, not source code truth.

## Technical questions answered

### 1) How do you make headings render larger inline?
Best pattern:
1. Assign heading line/node classes via syntax-tree-based line decorations.
2. Hide heading markers (`#`, trailing spaces) with replace decorations when cursor is outside.
3. Style heading classes in theme/CSS (`font-size`, weight).

Reference pattern:
- SilverBullet line-wrapper + heading mark hiding.

Minimal sketch:
```ts
if (node.type.name.startsWith("ATXHeading") && !cursorIn(node)) {
  const text = state.sliceDoc(node.from, node.to)
  const firstSpace = text.indexOf(" ")
  if (firstSpace > -1) {
    add(Decoration.replace({}).range(node.from, node.from + firstSpace + 1))
  }
  add(Decoration.line({ class: "md-h" + level }).range(node.from))
}
```

### 2) How do you hide markdown syntax chars when cursor is elsewhere?
Use syntax tree node types (`EmphasisMark`, `CodeMark`, `LinkMark`, `HeaderMark`, etc.) and selection intersection checks.

Key rule:
- If cursor/selection intersects the parent formatted span, show raw syntax.
- Else hide marks using `Decoration.replace({})` for mark ranges.

This is the most reliable way to avoid editing confusion.

### 3) How do you render images inline from image syntax?
Pattern:
1. Find `Image` nodes (or link/image syntax node set).
2. If cursor outside node, hide source range.
3. Insert block/inline widget at node start rendering `<img>` (or richer transclusion).
4. On click/Alt-click, move cursor to source range start for editing.

SilverBullet does this with `inline_content.ts` and widget callbacks.

### 4) How do you render mermaid diagrams inline from fenced code blocks?
Recommended CM6 pattern:
1. Detect fenced code node with info string `mermaid` via syntax tree.
2. Replace full fenced range with a block widget (`Decoration.replace({block:true, widget})`).
3. Render diagram in sandbox/isolated DOM (iframe strongly recommended for untrusted content/plugins).
4. Cache rendered height and call `requestMeasure` when the SVG height changes.
5. Click behavior:
  - Normal click: focus block / optional interaction.
  - Alt-click (or modifier): jump cursor to underlying markdown source.

SilverBullet architecture path:
- `fenced_code.ts` delegates per-language code widget callbacks.
- `silverbullet-mermaid` registers `codeWidget: mermaid` and returns HTML+script payload.

### 5) How do you handle cursor position when decorations change visual layout?
Key techniques:
- Never replace the node/line containing current selection (reveal raw markdown there).
- Use `EditorView.atomicRanges` for larger replace spans so cursor motion/backspace treats them atomically.
- For clickable widgets, use `mousedown` + `preventDefault` before CM moves cursor.
- Map positions through doc changes (`decoSet.map(tr.changes)`) when preserving decoration sets.
- For widget clicks, resolve live position with `view.posAtDOM(widgetDom, 0)` instead of stale captured offsets.

References:
- CM decoration example atomic ranges section.
- SilverBullet task/widget utilities.
- CM discuss thread on atomic range behavior: https://discuss.codemirror.net/t/backspace-on-decoration-with-atomic-ranges-not-working-correctly/6641

### 6) ViewPlugin vs StateField: which for each decoration type?
Recommended split for Meridian:
- Use `ViewPlugin` (viewport-limited, indirect) for:
  - bold/italic marker hiding
  - link punctuation hiding + mark styling
  - lightweight heading marker hiding (if not changing block structure)
  - other purely visual inline transforms
- Use `StateField` (direct) for:
  - block widgets (images if block-level, tables, fenced code previews, mermaid, embeds)
  - any replacement/line decoration that changes vertical layout or depends on full-doc state
  - atomic ranges source for replaced spans

### 7) How to handle multi-line replace decorations?
- Use a single range from block start to block end with `Decoration.replace({widget, block:true})`.
- Ensure this decoration is provided directly (`StateField -> EditorView.decorations.from(field)`).
- If mixing hidden lines and widget, avoid conflicting overlapping replacements in same region.
- Prefer full-block replacement for tables/mermaid/code fences; avoid line-by-line overlapping replacements when possible.

### 8) Performance for large documents (1000+ lines)
Practical guidance:
- Use syntax-tree scans over `view.visibleRanges` in `ViewPlugin` for inline decorations.
- Avoid full-doc traversal on every cursor move.
- Recompute only on relevant updates (`docChanged`, `selectionSet`, `viewportChanged`, `focusChanged` as needed).
- Map old decoration sets across changes when possible, instead of full rebuild.
- Skip expensive recompute during IME composition (SilverBullet pattern).
- Implement `WidgetType.eq` and optionally `updateDOM`.
- Provide `estimatedHeight` for block widgets; measure dynamic changes explicitly.

### 9) How to handle click events on widgets (`ignoreEvent`)?
- `ignoreEvent() { return false }` if editor/plugin should receive widget events.
- Keep event logic in plugin `eventHandlers` or widget DOM listeners.
- For interactions that must not move cursor first, handle `mousedown` and call `preventDefault`.
- If widget should be inert to CM editing behavior, leave default ignore behavior and stop propagation inside widget handlers.

## Feature-by-feature patterns for requested UI

### Headings
- Hide `#` markers when not editing heading.
- Add line class `md-h1..md-h6` with larger size/weight.
- Keep active heading line raw.

### Bold/Italic
- Hide `**`, `*`, `_` marks outside active span.
- Apply styles via highlight style or mark classes.

### Links
- Hide markdown punctuation.
- Render visible text as anchor (`Decoration.mark({tagName:"a", attributes:{href}})`).
- Ensure click handler uses safe navigation behavior (open externally or app route).

### Images
- Replace full image syntax with inline/block image widget.
- Limit max width and preserve aspect ratio.
- Modifier click reveals source.

### Code blocks
- If focused: show raw fenced code.
- If unfocused: replace with syntax-highlighted block widget.
- Keep copy button or quick action optional.

### Mermaid diagrams
- Treat as specialized fenced code widget (`info === "mermaid"`).
- Render SVG asynchronously; request measure after render.
- Strongly prefer sandboxed execution boundary.

### Block quotes
- Hide quote markers outside active line.
- Add line decoration class for left border + spacing.

### Lists
- Replace bullet markers with styled bullets/check widgets when unfocused.
- Keep indentation by line classes tied to nesting depth.

### Horizontal rules
- Replace raw `---`/`***`/`___` with line decoration class or `hr` widget when unfocused.

## Recommended architecture for Meridian frontend-v2

## Extension layout
Add new editor modules:
- `frontend-v2/src/editor/livePreview/index.ts`
- `frontend-v2/src/editor/livePreview/inlineDecorations.ts`
- `frontend-v2/src/editor/livePreview/blockDecorations.ts`
- `frontend-v2/src/editor/livePreview/widgets/*.ts`
- `frontend-v2/src/editor/livePreview/events.ts`

## Integration points
- `Editor.tsx`: include `livePreviewExtension({...})` in `extensions` list.
- `theme.ts`: add classes used by live preview decorations/widgets.
- `highlight.ts`: keep semantic styling; do not rely on highlight alone for syntax hiding.

## State model
- One compartment for toggling `livePreview` on/off at runtime.
- Keep `readOnly` and placeholder compartments as-is.

## Data flow
1. Parse markdown with existing `markdown()` language support.
2. Inline ViewPlugin builds viewport-based cosmetic decorations.
3. Block StateField builds full-doc structural replacements.
4. Event layer maps widget clicks back to source positions.

## Implementation order (recommended)
1. Foundation
- Add live preview toggle compartment.
- Build shared cursor-range utility (`isCursorInRange` equivalent).

2. Low-risk inline transforms
- Heading marker hiding + heading sizing classes.
- Bold/italic/code marker hiding.
- Link punctuation hiding + clickable link text.

3. Structural basics
- Horizontal rule line replacement.
- Blockquote marker hiding + line border styling.
- List bullet replacement and indentation classes.

4. Media/widgets
- Inline images (safe URL handling + sizing + source reveal).
- Code block preview widget with syntax highlighting.

5. Advanced widgets
- Mermaid block widget (sandbox + async render + height measurement).

6. Hardening
- Atomic ranges wiring for replaced spans.
- IME optimization paths.
- Stress/perf tests on 1000+ line docs.

## Known gotchas (from real-world usage)
- Block widget cursor/selection edge cases are common (navigation into/out of replaced blocks can feel odd).
  - See rich-markdoc known issues + CM discuss threads.
- If `ignoreEvent` is wrong, clicks either do nothing or unexpectedly move cursor.
- Hidden syntax + selection across boundaries can create surprising selection visuals unless active-region reveal rules are strict.
- Regex-only parsing looks simpler but breaks on nested markdown and edge cases; syntax-tree-first is much safer.
- Performance can degrade quickly when token hiding/rendering recomputes full doc each update.

## Reference links
- CodeMirror reference manual: https://codemirror.net/docs/ref/
- Decoration API example: https://codemirror.net/examples/decoration/
- Styling/Themes example: https://codemirror.net/examples/styling/
- CodeMirror guide (decorating doc, state fields, view plugins): https://codemirror.net/docs/guide/
- `@codemirror/view` source (Decoration/WidgetType): https://github.com/codemirror/view/blob/main/src/decoration.ts
- `@codemirror/view` source (`EditorView.theme`): https://github.com/codemirror/view/blob/main/src/editorview.ts
- `@codemirror/lang-markdown`: https://github.com/codemirror/lang-markdown
- SilverBullet repo: https://github.com/silverbulletmd/silverbullet
- SilverBullet live preview doc: https://silverbullet.md/Live%20Preview
- SilverBullet mermaid plug: https://github.com/silverbulletmd/silverbullet-mermaid
- `codemirror-rich-markdoc`: https://github.com/segphault/codemirror-rich-markdoc
- `codemirror-markdown-hybrid`: https://github.com/tiagosimoes/codemirror-markdown-hybrid
- CM discuss (hybrid markdown): https://discuss.codemirror.net/t/hybrid-markdown-editing-preview-for-unfocused-lines-raw-for-active-line/9660
- CM discuss (atomic ranges/backspace): https://discuss.codemirror.net/t/backspace-on-decoration-with-atomic-ranges-not-working-correctly/6641
- Obsidian Live Preview update: https://obsidian.md/blog/live-preview-update/
- Obsidian CM6 changelog entry: https://obsidian.md/changelog/2021-12-09-desktop-v0.13.8/
- Obsidian plugin docs (decorations): https://docs.obsidian.md/Plugins/Editor/Decorations
- Obsidian CM options plugin (historical performance/gotchas context): https://github.com/nothingislost/obsidian-codemirror-options
