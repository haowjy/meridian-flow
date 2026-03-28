# CodeMirror 6: Production Live-Preview Markdown Editor Research

> Researched 2026-03-26. Sources: CM6 official docs (codemirror.net), CM6 discussion forum (discuss.codemirror.net), Marijn Haverbeke's blog posts, GitHub projects (y-codemirror.next, codemirror-rich-markdoc, obsidian-codemirror-options), and community experience reports.

---

## 1. React Integration

### The Fundamental Tension

CM6 is framework-agnostic and manages its own DOM. React wants to own the DOM. These two philosophies conflict. The correct approach is to treat CM6 as an **uncontrolled component** where CM6 is the source of truth for document state, and React observes changes rather than dictating them.

### Recommended Pattern: Uncontrolled with Refs

```tsx
function Editor({ initialDoc, extensions, onChange }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView>();

  // Create once, destroy on unmount
  useEffect(() => {
    const view = new EditorView({
      state: EditorState.create({
        doc: initialDoc,
        extensions: [
          ...extensions,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChange?.(update);
          }),
        ],
      }),
      parent: containerRef.current!,
    });
    viewRef.current = view;
    return () => view.destroy();
  }, []); // Empty deps -- create once

  return <div ref={containerRef} />;
}
```

### Anti-Pattern: Controlled Component

Attempting to make CM6 behave like a controlled React input (intercepting transactions, feeding `value` back in) causes:

- **Range mismatch crashes**: Blocking `docChanged` transactions while the browser's EditContext still updates internal positions leads to "range error - invalid change range."
- **Composition event corruption**: Input methods (CJK, German umlauts) accumulate intermediate characters instead of resolving to the final composed character.
- **Chrome EditContext bugs**: Marijn implemented workarounds but stated "a proper solution would require Chrome fixing their implementation." This is a fundamental impedance mismatch.

**Marijn's stance**: He declined to debug wrapper code that tries to make CM6 controlled, saying he doesn't "volunteer to debug issues caused by wrapper code that I don't maintain." The message is clear: do not fight CM6's ownership model.

### How @uiw/react-codemirror Works

The library exposes `value` and `onChange` props to feel "react-y," but internally it manages the CM6 lifecycle imperatively. It uses compartment reconfiguration for dynamic extension changes. Known issues:

- **Re-render sensitivity**: Even passing a new anonymous object to options triggers re-renders. Extensions must be memoized (`useMemo`) or defined outside components.
- **Performance overhead**: The controlled `value` prop dispatches replacement changes on every external update, which can cause cursor jumps and performance issues on large docs.

### Compartment Pattern for Dynamic Config from React

When React props change (theme, language, read-only), use compartments rather than recreating the view:

```tsx
const themeCompartment = useRef(new Compartment());

// On theme change:
useEffect(() => {
  if (viewRef.current) {
    viewRef.current.dispatch({
      effects: themeCompartment.current.reconfigure(newTheme),
    });
  }
}, [newTheme]);
```

### When to Recreate vs Reconfigure

| Scenario | Approach |
|----------|----------|
| Theme/language change | Compartment reconfigure |
| Read-only toggle | Compartment reconfigure |
| Extension set changes | Compartment reconfigure |
| Completely different document | `view.setState()` with full config |
| Same doc, minor config tweak | Dispatch with effects |

**Never** recreate the EditorView just because a React prop changed. The view is expensive to construct and destroys all plugin state.

---

## 2. Extension Architecture

### Core Primitives Decision Guide

| Primitive | Use When | Example |
|-----------|----------|---------|
| **Facet** | Multiple extensions need to contribute values to a shared concern | Tab size, keymaps, event handlers, decoration sources |
| **StateField** | You need persistent state tied to the document lifecycle, updated via transactions | Cursor-aware decoration set, lint diagnostics, breakpoint positions |
| **StateEffect** | You need to trigger a state field update from outside (user action, external event) | Toggle a feature, add a diagnostic, mark a range |
| **ViewPlugin** | You need imperative DOM access, event handlers, or viewport-dependent logic | Tooltip positioning, scroll-aware decorations, DOM event listeners |
| **Compartment** | You need to swap config at runtime based on external events | Language switching, theme toggling, read-only mode |
| **Computed Facet** | The config value is derivable from existing state | "Read-only if document has error" -- derives from other state |

### Computed Facets vs Compartments

Marijn explicitly recommends: **use computed facets when the value derives from state; use compartments when changes are event-driven.** Computed facets are "more efficient and easier to keep track of" because they are derived state, not new fundamental state. They automatically recompute when dependencies change.

Compartments are for when you "need to reconfigure from time to time" based on external triggers (user toggled a setting, different file type loaded).

### Extension Ordering

Extensions are resolved in two passes:

1. **Precedence bucket**: `Prec.highest > Prec.high > default > Prec.low > Prec.lowest`
2. **Position within bucket**: Earlier in the flattened array = higher priority

Concrete example:
```js
[Prec.high(keymapA), keymapB, Prec.high([keymapC, keymapD])]
// Effective order: A, C, D, B
```

**Common mistake**: Forgetting `Prec.high()` on custom keymaps, causing them to be shadowed by `basicSetup`'s built-in bindings.

**Anti-pattern**: Using numeric priority values. CM6 deliberately uses named categories to avoid the "comically large z-index" problem.

### Extension Composition Pattern

A well-structured extension bundles its concerns:

```ts
function myMarkdownPreview(config: PreviewConfig): Extension {
  const configFacet = defineFacet<PreviewConfig>({ combine: mergeConfigs });
  return [
    configFacet.of(config),
    previewStateField,       // StateField for decoration state
    previewViewPlugin,       // ViewPlugin for cursor tracking
    previewBaseTheme,        // Base CSS via EditorView.baseTheme
    previewKeymap,           // Keymap bindings
  ];
}
```

### Deduplication

CM6 deduplicates extensions by identity. If the same extension instance appears multiple times in the tree (because multiple consumers depend on it), only the highest-precedence occurrence is kept. This means: **do not create new extension instances on every render**.

---

## 3. Live Preview / WYSIWYG Patterns

### Marijn's Warning

When asked directly about WYSIWYG markdown in CM6, Marijn recommended ProseMirror instead: "Probably. It'll definitely involve less fighting against the library." He noted that "something like tables is probably not going to work" with CM6's approach. However, projects like Obsidian prove it is possible for non-table content.

### Architecture: Cursor-Aware Decoration Hiding

The canonical pattern used by Obsidian, codemirror-rich-markdoc, and similar projects:

1. **Parse the syntax tree** (from `@lezer/markdown` via `syntaxTree(state)`) to identify markdown syntax nodes
2. **Build decorations** that hide/replace syntax characters
3. **Filter decorations** to exclude the range around the cursor, revealing syntax for editing

#### Two-Strategy Approach (codemirror-rich-markdoc)

- **Inline formatting** (bold, italic, links): Apply mark decorations with a CSS class (e.g., `cm-markdoc-hidden`) that hides syntax characters. Reveal when cursor enters the range.
- **Block structures** (tables, blockquotes): Replace entire regions with block widget decorations rendering HTML. Collapse to source when cursor enters.

#### Cursor Filtering Pattern

```ts
// In ViewPlugin.update():
update(update: ViewUpdate) {
  // Rebuild decorations from syntax tree
  let decos = buildDecorationsFromTree(update.state);

  // Filter out decorations that overlap with cursor
  for (const range of update.state.selection.ranges) {
    decos = decos.update({
      filter(from, to) {
        return to < range.from || from > range.to;
      },
    });
  }
  this.decorations = decos;
}
```

### Decoration Strategy Decision

| Content Type | Decoration | Rationale |
|-------------|------------|-----------|
| Bold/italic syntax (`**`, `_`) | `Decoration.mark` + CSS `display:none` | Preserves content flow, simple to reveal on cursor |
| Heading `#` chars | `Decoration.replace` (empty) | Removes from flow, heading styled via line decoration |
| Links `[text](url)` | `Decoration.replace` with widget | Show clickable link, reveal full syntax on cursor |
| Code blocks | `Decoration.mark` for fence, line decorations for block | Keep editable, style the container |
| Tables | `Decoration.replace` with block widget | CM6 cannot handle table layout natively |

### Critical: Use `drawSelection` When Hiding Syntax

When using mark decorations that hide characters (via CSS negative margins or `display:none`), the native browser cursor can become invisible or misaligned. **Marijn's fix**: enable `drawSelection()` to replace native cursor rendering with CM6's own cursor drawing. This resolves cursor visibility glitches when syntax characters are hidden.

### Avoid `atomicRanges` for Syntax Hiding

Using `atomicRanges` with mark decorations causes the entire decorated range to be treated as a single cursor unit. Pressing backspace deletes the whole range instead of one character. Reserve `atomicRanges` for truly atomic elements (embedded widgets, emoji).

---

## 4. Collaboration Integration (Yjs)

### Stack: y-codemirror.next

The binding (`y-codemirror.next`) connects `Y.Text` to CM6. Current release: v0.3.5.

```ts
import { yCollab } from 'y-codemirror.next';

const ydoc = new Y.Doc();
const ytext = ydoc.getText('document');
const undoManager = new Y.UndoManager(ytext);

const state = EditorState.create({
  extensions: [
    // ... other extensions
    yCollab(ytext, provider.awareness, { undoManager }),
    // Do NOT include @codemirror/history -- yUndoManager replaces it
  ],
});
```

### Critical: Do NOT Include CM6 History

When using Yjs collaboration, you **must not** include the `history()` extension from `@codemirror/commands`. The `Y.UndoManager` replaces it entirely. Including both creates conflicting undo stacks where:

- CM6 history tracks local state changes
- Y.UndoManager tracks collaborative changes
- Undo operations fight each other, producing corrupted state

### Undo Manager Behavior

- `Y.UndoManager` tracks only local changes by default
- Remote changes are not added to the local undo stack
- Each client gets independent undo/redo history
- Keybindings for undo/redo must be wired to `yUndoManager.undo()` / `yUndoManager.redo()`

### Awareness Protocol

The awareness plugin renders remote cursors and selection ranges. Users set their identity via:

```ts
provider.awareness.setLocalStateField('user', {
  name: 'Alice',
  color: '#ff0000',
  colorLight: '#ff000033',
});
```

**Ghost cursor problem**: Clear awareness state on disconnect/reconnect to prevent stale remote cursors from lingering.

### Document Lifecycle with Yjs

| Event | Action |
|-------|--------|
| Open document | Create Y.Doc, connect provider, create EditorState with yCollab |
| Switch document (tab) | Disconnect old provider, destroy/create new Y.Doc + EditorState |
| Close document | Disconnect provider, destroy awareness, destroy EditorView or setState |
| Reconnect | Provider handles automatic re-sync; awareness needs explicit cleanup |

### CM6 collab Extension vs Yjs

CM6 has its own `@codemirror/collab` extension using operational transformation with a central authority. This is a **different system** from Yjs. Do not mix them. Choose one:

- **`@codemirror/collab`**: OT-based, needs a central server, simpler for single-server setups
- **Yjs (y-codemirror.next)**: CRDT-based, supports P2P, offline-first, more complex but more resilient

---

## 5. Performance

### ViewPlugin vs StateField Performance

| Aspect | StateField | ViewPlugin |
|--------|-----------|------------|
| Update frequency | Every transaction | Every view update (superset of transactions) |
| Access to viewport | No (computed before viewport) | Yes (`view.visibleRanges`) |
| Decoration constraint | Only "direct" decorations (can affect block structure) | Can provide "indirect" decorations (viewport-aware) |
| Best for | Persistent state, user-created annotations | Viewport-dependent rendering, DOM management |

**Key rule**: Decorations that affect vertical block structure (block widgets, line decorations that change height) **must** come from StateField (direct). Decorations that only style visible content (syntax highlighting, search matches) **should** come from ViewPlugin (indirect) for performance.

### Decoration Rebuild Strategies

1. **Map through changes** (preferred for persistent decorations):
   ```ts
   update(update: ViewUpdate) {
     if (update.docChanged) {
       this.decorations = this.decorations.map(update.changes);
     }
   }
   ```
   Efficient: O(changes), not O(document).

2. **Rebuild from syntax tree** (for syntax-dependent decorations):
   ```ts
   update(update: ViewUpdate) {
     if (update.docChanged || update.viewportChanged ||
         syntaxTree(update.state) !== syntaxTree(update.startState)) {
       this.decorations = buildDecorations(update.view);
     }
   }
   ```
   Rebuild only when tree actually changes.

3. **Viewport-only rebuild** (for large documents):
   ```ts
   function buildDecorations(view: EditorView) {
     const builder = new RangeSetBuilder<Decoration>();
     for (const { from, to } of view.visibleRanges) {
       syntaxTree(view.state).iterate({
         from, to,
         enter(node) { /* add decorations */ },
       });
     }
     return builder.finish();
   }
   ```

### Common Performance Pitfalls

1. **MatchDecorator full rebuild bug**: A bug in MatchDecorator caused full decoration rebuilds on every edit (when `viewportChanged` was true on normal edits). This was fixed, but verify you are on a recent version of `@codemirror/view`.

2. **Rebuilding all decorations on every keystroke**: Always check `update.docChanged || update.viewportChanged` before rebuilding. Never unconditionally rebuild.

3. **Not using `visibleRanges`**: For documents >10K lines, iterating the full syntax tree is expensive. Always scope to visible ranges for ViewPlugin decorations.

4. **Widget `eq()` not implemented**: Without `eq()`, CM6 cannot reuse widget DOM elements and recreates them on every update. Always implement `eq()` and `updateDOM()` on WidgetType subclasses.

5. **Creating extension instances in render**: Extensions created inside React render functions get new identity each time, defeating deduplication and causing full reconfiguration on every render.

6. **StateField holding non-derived view state**: "View plugins should generally not hold (non-derived) state" but the converse is also true: StateFields should not store data that is purely view-derived (e.g., viewport info).

### Viewport Rendering

CM6 only renders the visible portion of the document plus a margin. This is automatic but has implications:
- Widget `toDOM()` is only called when the widget scrolls into view
- Plugins cannot assume all content is rendered
- `ensureSyntaxTree(state, pos)` may return incomplete trees for viewport-aware parsers

---

## 6. Tab Management (Multi-Document)

### Recommended Pattern: One State Per Document, One View

Marijn recommends keeping a `Map<string, EditorState>` where each open document has its own state. A single `EditorView` instance is reused, with `view.setState(savedState)` called on tab switch.

```ts
const states = new Map<string, EditorState>();

function switchTab(docId: string) {
  // Save current state
  states.set(currentDocId, view.state);

  // Restore or create target state
  let state = states.get(docId);
  if (!state) {
    state = EditorState.create({
      doc: loadDoc(docId),
      extensions: sharedExtensions,
    });
  }

  view.setState(state);
  currentDocId = docId;
}
```

### setState vs dispatch for Tab Switching

| Approach | Behavior | Use When |
|----------|----------|----------|
| `view.setState(state)` | Full state replacement. Resets all plugin state. | Switching to a completely different document |
| `view.dispatch({changes: ...})` | Incremental update within same state. Preserves history, plugins. | Replacing content within the same conceptual document |

**Caveat with `setState()`**: You must include all extensions in the state you pass. If you create a bare `EditorState.create({doc: ...})` without extensions, you lose all configuration. The saved state from `view.state` already has extensions, so restoring it works correctly.

### Alternative: One View Per Tab (Hidden)

For applications that need instant tab switching without re-render latency:

- Create an `EditorView` for each open document
- Mount all views in the DOM, hide inactive ones with CSS
- Only the visible view processes viewport events

**Tradeoffs**: Higher memory usage (one view per tab), but zero latency on switch. Good for <10 tabs, problematic for 100+.

### With Yjs Collaboration

Each tab needs its own Y.Doc and provider connection. When switching tabs:

1. The old tab's Y.Doc stays connected (to receive remote updates)
2. The new tab's Y.Doc connection is verified
3. `view.setState()` swaps to the new document's state
4. Awareness is updated to reflect the current document

This is more complex than single-document tab management because you cannot disconnect/reconnect on every tab switch without losing sync.

---

## Summary of Key Recommendations

| Topic | Do | Do Not |
|-------|-----|--------|
| React integration | Uncontrolled component, CM6 owns state, React observes via updateListener | Controlled component pattern, intercepting transactions |
| Dynamic config | Compartments for event-driven changes, computed facets for derived values | Recreating EditorView on prop changes |
| Extension ordering | Use `Prec.high()` for custom keymaps, define extensions outside components | Numeric priorities, creating extensions in render |
| Live preview | ViewPlugin with cursor-aware decoration filtering, `drawSelection()` | `atomicRanges` for syntax hiding, tables in CM6 |
| Yjs collab | `yCollab()` with `Y.UndoManager`, exclude CM6 history | Mixing `@codemirror/collab` and Yjs, including `history()` with yCollab |
| Performance | Viewport-scoped decoration rebuilds, map through changes, implement `eq()` | Full-document decoration rebuilds, unconditional rebuilds on update |
| Tab management | One state per document in a Map, single view with `setState()` | Bare `setState()` without extensions, recreating view per tab |

---

## Sources

- [CM6 System Guide](https://codemirror.net/docs/guide/)
- [CM6 Configuration Example](https://codemirror.net/examples/config/)
- [CM6 Decoration Example](https://codemirror.net/examples/decoration/)
- [CM6 Collaboration Example](https://codemirror.net/examples/collab/)
- [CM6 Split View Example](https://codemirror.net/examples/split/)
- [Marijn Haverbeke: Extensible Extension Mechanisms](https://marijnhaverbeke.nl/blog/extensibility.html)
- [Marijn Haverbeke: Facets as Composable Extension Points](https://marijnhaverbeke.nl/blog/facets.html)
- [Hiding markdown syntax - CM6 Forum](https://discuss.codemirror.net/t/hide-markdown-syntax/7602)
- [Cursor misalignment with Decoration.mark - CM6 Forum](https://discuss.codemirror.net/t/regarding-the-issue-of-cursor-misalignment-when-using-decoration-mark-to-hide-symbols/9354)
- [Implementing WYSIWYG Markdown in CM - CM6 Forum](https://discuss.codemirror.net/t/implementing-wysiwyg-markdown-editor-in-codemirror/2403)
- [Controlled component crash - CM6 Forum](https://discuss.codemirror.net/t/editor-crashing-when-used-as-controlled-component-in-react/8457)
- [Performance issues with extension - CM6 Forum](https://discuss.codemirror.net/t/performance-issues-with-extension/8896)
- [Preserving state when switching files - CM6 Forum](https://discuss.codemirror.net/t/preserving-state-when-switching-between-files/2946)
- [Dynamic reconfiguration, computed facets - CM6 Forum](https://discuss.codemirror.net/t/dynamic-reconfiguration-known-facets/8045)
- [y-codemirror.next GitHub](https://github.com/yjs/y-codemirror.next)
- [codemirror-rich-markdoc GitHub](https://github.com/segphault/codemirror-rich-markdoc)
- [Obsidian CM6 options GitHub](https://github.com/nothingislost/obsidian-codemirror-options)
- [@uiw/react-codemirror GitHub](https://github.com/uiwjs/react-codemirror)
