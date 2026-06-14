# Cursor Jump Investigation

Investigation of the editor cursor-jump-while-typing bug in the v1 frontend.

## Summary

The cursor-jump bug has **multiple contributing causes**, ranked by severity. The architecture is generally sound but has a few specific code paths where external dispatches can reset or interfere with cursor position during typing.

---

## Root Cause 1 (HIGH): `refreshDocument` triggers full-doc replacement during active editing

**Files**: `useEditorStore.ts:189-217`, `useDocumentContent.ts:247-302`, `toolResultSideEffects.ts:90-95`, `lifecycleEventHandlers.ts:124-131`

**Mechanism**:

1. While the user is typing, an AI tool result or run completion triggers `refreshDocument(documentId)`.
2. `refreshDocument` fetches fresh content from the server and calls `set({ activeDocument: doc })`.
3. The `useDocumentContent` initialization effect (line 247) fires because `activeDocument` reference changed.
4. Since `editVersion > 0` (user has been typing), the effect stashes the server content as `pendingServerSnapshot` (line 276) -- this path is SAFE.
5. **BUT**: There is a race window. The `loadWithPolicy` path in `loadDocument` (line 74-94) has an `onIntermediate` callback that sets `activeDocument` from cache **and then** sets it again from the network response. Each set triggers the initialization effect.
6. If the timing is unlucky, the second `set({ activeDocument: final.data })` arrives with `editVersion === 0` (because `resetEditVersion` was just called by a save completing), causing a full hydration that replaces editor content.

**The hydration itself preserves cursor** (thanks to `dispatchSetContent`'s clamping at line 117-119), but the content replacement dispatches `changes: { from: 0, to: doc.length, insert: content }` which causes CM6 to rebuild all decorations, reparse the syntax tree, and reflow. If the old and new content differ even slightly (e.g., trailing whitespace, server normalization), the cursor position clamp may place the cursor at a different logical position.

**Why this causes jumps**: Even with the idempotency check at line 100 (`if (view.state.doc.toString() === content) return`), if the server normalizes content differently (e.g., trailing newline), the content won't match and a full replacement occurs.

---

## Root Cause 2 (HIGH): `useEditorCache.ts` external content sync with no selection preservation

**File**: `useEditorCache.ts:131-147`

```typescript
useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const currentContent = view.state.doc.toString();
    if (currentContent !== initialContent && initialContent !== "") {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: initialContent },
      });
    }
}, [initialContent]);
```

This effect dispatches a full-document replacement **without preserving cursor position**. The `CodeMirrorEditor.tsx`'s `dispatchSetContent` carefully preserves selection (lines 117-119), but `useEditorCache.ts` does a raw `view.dispatch({ changes: ... })` with no `selection` field -- CM6 defaults to placing cursor at position 0 or mapping it through the change, which for a full replacement means cursor goes to position 0.

**However**: `useEditorCache` is not used by `EditorPanel`. It's an alternate code path (only imported in `useEditorCache.ts` and the cache index). So this is a latent bug, not the primary cause in the current code path. It becomes active if anyone uses the `useEditorCache` hook directly.

---

## Root Cause 3 (MEDIUM): Live preview decoration rebuilds during typing cause visual cursor displacement

**File**: `livePreview/plugin.ts:122-151`

The `LivePreviewPlugin.update()` method rebuilds ALL decorations on every `docChanged` event (line 123-126):

```typescript
update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged) {
      this.decorations = this.buildDecorations(update.view);
      return;
    }
```

`buildDecorations` iterates the entire visible syntax tree and produces `Decoration.replace({})` decorations that hide markdown syntax (e.g., `**`, `#`, `[[`). When these replace decorations are rebuilt:

1. If the cursor is near a formatting boundary (e.g., typing inside `**bold text**`), the rebuild may toggle whether markers are hidden or visible based on `cursorInSameWord`.
2. This toggle adds/removes `Decoration.replace({})` ranges, which changes the visual mapping between document positions and screen positions.
3. CM6 handles this correctly at the document level, but the **visual position** of the cursor appears to jump because content shifts as markers appear/disappear.

This is the most commonly experienced "cursor jump" -- it's not a true cursor position change, but a visual displacement that feels like a jump to the writer.

---

## Root Cause 4 (MEDIUM): `HorizontalRuleWidget` and `BulletWidget` missing `eq()` cause unnecessary DOM recreation

**File**: `livePreview/renderers/horizontalRule.ts:23-29`

```typescript
class HorizontalRuleWidget extends WidgetType {
  toDOM(): HTMLElement {
    const hr = document.createElement("div");
    hr.className = "cm-hr-widget";
    return hr;
  }
  // NO eq() method!
}
```

**File**: `livePreview/renderers/list.ts:21-28`

```typescript
class BulletWidget extends WidgetType {
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-list-bullet-widget";
    span.textContent = "\u2022";
    return span;
  }
  // NO eq() method!
}
```

When `eq()` is not overridden, CM6's default implementation returns `false`, meaning every decoration rebuild recreates the widget DOM. For `HorizontalRuleWidget`, this means the `<div>` is destroyed and recreated on every keystroke (since `buildDecorations` runs on every `docChanged`). This causes a DOM mutation that can trigger a micro-layout shift visible as a flicker or cursor displacement near the widget.

`NumberWidget` (line 33) and `ExternalLinkWidget` (line 250) correctly implement `eq()`. `HorizontalRuleWidget` and `BulletWidget` do not.

---

## Root Cause 5 (LOW-MEDIUM): `parentScrollExtension` monkey-patches `posAtCoords` with a race window

**File**: `extensions/parentScrollExtension.ts:41-58`

```typescript
view.posAtCoords = ((coords, precise?) => {
    const adjustedCoords = {
        x: coords.x,
        y: coords.y + parentScroller.scrollTop,
    };
    return precise === false ? original(adjustedCoords, false) : original(adjustedCoords);
}) as typeof view.posAtCoords;

setTimeout(() => { view.posAtCoords = original; }, 0);
```

This temporarily replaces `posAtCoords` on mousedown and restores it via `setTimeout`. During the race window (~0ms), any other code calling `posAtCoords` gets adjusted coordinates when they shouldn't, or vice versa. The code comments acknowledge this risk.

**Impact**: Could cause click-to-position to land at wrong location, which the user perceives as a cursor jump when clicking to place the cursor.

---

## Root Cause 6 (LOW): `clickBelowContentExtension` dispatches cursor to end-of-document

**File**: `extensions/clickBelowContent.ts:11-30`

```typescript
mousedown(event, view) {
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos === null) {
      const endPos = view.state.doc.length;
      view.dispatch({
        selection: EditorSelection.cursor(endPos),
        scrollIntoView: true,
      });
      view.focus();
      return true;
    }
    return false;
}
```

If `posAtCoords` returns `null` (which can happen when the scroll container has padding or when coordinates are slightly off due to the `parentScrollExtension` race), the cursor jumps to the end of the document. Combined with Root Cause 5, this creates a scenario where clicking near the bottom of content could unexpectedly jump the cursor to the document end.

---

## Root Cause 7 (LOW): `wikiLinkPlugin` `setTimeout` selection restoration

**File**: `wikiLinks/wikiLinkPlugin.ts:97-108`

```typescript
const savedSelection = view.state.selection;
onRefClick(refId, refType, ref);
setTimeout(() => view.dispatch({ selection: savedSelection }), 0);
```

After a wiki-link click, the code saves selection and restores it via `setTimeout`. If the user types quickly between the click and the timeout, the restored selection will overwrite the new cursor position. This is a narrow race but possible on fast typists or slow machines.

---

## Non-Causes (Ruled Out)

### `key={documentId}` remounting
EditorPanel uses `<CodeMirrorEditor key={documentId} ...>` (line 357). This is **correct** -- it forces a clean editor mount when switching documents, which is necessary because the collab extensions are document-specific. The `key` change only triggers on document navigation, not during normal typing.

### Compartment reconfiguration
The `editableCompartment`, `themeCompartment`, and `livePreviewCompartment` reconfiguration does NOT reset cursor. CM6 compartment reconfiguration preserves selection by design.

### Yjs binding conflicts
The `yCollab` extension from `y-codemirror.next` is well-tested and handles selection correctly during remote updates. The `CollabSyncRuntime` correctly uses `origin === this` guards to prevent echo. This is not a cursor jump source.

### Editor cache eviction (editorCache.ts)
`editorCache` is only used for cleanup on project switch (`useProjectStore`). It does not participate in the active editing loop. The `useEditorCache` hook is not used by `EditorPanel`.

### React re-renders recreating EditorView
The `CodeMirrorEditor` component correctly uses `useEffect([], [])` (empty deps) to create the EditorView once on mount. The `eslint-disable-next-line` comment confirms this is intentional. React re-renders do NOT recreate the editor.

---

## Recommended Fixes

### Fix 1: Add `eq()` to `HorizontalRuleWidget` and `BulletWidget`

**Priority**: Quick win, low risk

```typescript
// horizontalRule.ts
class HorizontalRuleWidget extends WidgetType {
  toDOM(): HTMLElement {
    const hr = document.createElement("div");
    hr.className = "cm-hr-widget";
    return hr;
  }

  eq(): boolean {
    return true; // All HR widgets are identical
  }
}

// list.ts
class BulletWidget extends WidgetType {
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-list-bullet-widget";
    span.textContent = "\u2022";
    return span;
  }

  eq(): boolean {
    return true; // All bullet widgets are identical
  }
}
```

### Fix 2: Guard `refreshDocument` against active editing

**Priority**: High -- prevents the most impactful cursor jump scenario

In `useDocumentContent.ts`, the initialization effect (line 247) should check collab state more carefully:

```typescript
// In the initialization effect, add an additional guard:
// If the user is actively editing AND the content difference is only
// whitespace normalization, skip hydration entirely.
if (!docChanged && serverSentNewDoc && editVersion > 0) {
  // Already handled -- stashes as pendingServerSnapshot
  // This path is correct. The bug is that editVersion can be 0
  // when it shouldn't be (race with resetEditVersion).
  return;
}
```

The real fix is to make `resetEditVersion` more conservative -- only reset when the save response content matches the current editor content:

```typescript
const resetEditVersion = useCallback((savedAtVersion: number) => {
  setEditVersion((current) => {
    if (current !== savedAtVersion) return current;
    // Additional safety: verify editor content matches what was saved
    const editorContent = editorRef.current?.getContent();
    const storeContent = useEditorStore.getState().activeDocument?.content;
    if (editorContent !== undefined && storeContent !== undefined && editorContent !== storeContent) {
      return current; // Don't reset -- content diverged
    }
    return 0;
  });
}, [editorRef]);
```

### Fix 3: Add selection preservation to `useEditorCache.ts` content sync

**Priority**: Low (not currently in active code path, but prevents future bugs)

```typescript
useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const currentContent = view.state.doc.toString();
    if (currentContent !== initialContent && initialContent !== "") {
      // Preserve cursor position (clamped to new content length)
      const oldSel = view.state.selection.main;
      const anchor = Math.min(oldSel.anchor, initialContent.length);
      const head = Math.min(oldSel.head, initialContent.length);
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: initialContent },
        selection: { anchor, head },
      });
    }
}, [initialContent]);
```

### Fix 4: Debounce live preview decoration rebuilds for typing

**Priority**: Medium -- reduces visual cursor displacement during rapid typing

```typescript
// In LivePreviewPlugin.update():
update(update: ViewUpdate) {
    if (update.docChanged) {
      // For doc changes, rebuild decorations but use a flag to batch rapid updates
      this.decorations = this.buildDecorations(update.view);
      return;
    }
    // ... rest stays the same
}
```

This is already optimal -- CM6 batches updates within the same event loop tick. The visual displacement is inherent to the live preview approach and can only be fully eliminated by switching to a StateField (which CM6 recommends for decorations that depend on document content). However, the current ViewPlugin approach works because live preview decorations also depend on selection (cursor position), which ViewPlugins can read but StateFields cannot.

A partial mitigation: skip rebuild when the doc change is a single character insertion on a line with no markdown syntax:

```typescript
update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged) {
      // Optimization: skip full rebuild for simple insertions on plain lines
      // (no markdown syntax to hide/show)
      // This is a future optimization, not critical for the cursor jump fix
      this.decorations = this.buildDecorations(update.view);
      return;
    }
```

---

## Good Patterns Worth Carrying to frontend-v2

### Store Architecture
- **Race prevention**: `_activeDocumentId` guard pattern (set sync before await, check after) -- excellent pattern for preventing stale state from background operations.
- **Subscribe for Display, Read for Action**: Clear convention documented in CLAUDE.md prevents infinite loops. Worth formalizing as a lint rule.
- **Abort controllers**: Consistent use of AbortController for all async loads with proper cleanup in useEffect returns.

### Editor Integration
- **Compartments for dynamic config**: Using CM6 Compartments for editable/theme/livePreview is exactly the right approach. Avoids editor recreation for config changes.
- **`suppressOnChange` annotation**: Custom annotation to prevent onChange callbacks during programmatic content updates. Prevents save loops.
- **Idempotent `dispatchSetContent`**: The content equality check (`view.state.doc.toString() === content`) prevents unnecessary dispatches. Selection clamping prevents cursor-to-0.
- **`key={documentId}`**: Forces clean mount on document switch. Correct for collab where extensions are document-specific.
- **Empty deps useEffect for editor creation**: Prevents React re-renders from recreating the EditorView. Standard CM6+React pattern.
- **Callback refs for stable extensions**: `useInlineReview` uses ref-based callbacks so the extension array stays stable across re-renders. Critical for CM6 where extensions are read once at mount.

### Decoration Patterns
- **Registry pattern for renderers**: `registerRenderer()` / `getRenderers()` OCP pattern makes it trivial to add new markdown node types.
- **ViewPlugin for selection-dependent decorations**: Correct choice since live preview needs cursor position (ViewPlugin has access to ViewUpdate).
- **StateField for block widgets**: Inline review correctly uses StateField for block-level decorations (CM6 requirement).
- **`eq()` on stateful widgets**: `ExternalLinkWidget`, `NumberWidget`, `HunkActionWidget`, `InsertedTextWidget` all correctly implement `eq()`.

### Streaming / Real-time Sync
- **Yjs integration**: Clean separation: `CollabSyncRuntime` handles protocol, `DocumentSessionManager` handles WebSocket lifecycle, `useDocumentCollab` bridges to React.
- **Transport-agnostic runtime**: `CollabSyncRuntime` accepts a `sendBinary` callback, making it testable and transport-independent.
- **IDB persistence with timeout**: 3-second timeout prevents editor from blocking forever if IndexedDB is corrupted.
- **`isResolvingRef` guard**: Prevents Yjs mutation from re-triggering hunk sync during accept/reject. Clever use of `queueMicrotask` for cleanup.

### Editor Caching Strategy
- **LRU cache with scroll preservation**: `editorCache.ts` stores EditorState + scroll position. Simple LRU eviction (5 editors max).
- **Separate from active editing path**: Cache is only for document switching, not for the active editing loop. Good separation.

### Other Notable Patterns
- **`computeHunkSignature` for skip-dispatch optimization**: djb2 hash of hunk text prevents unnecessary CM6 state updates during typing when proposals are active.
- **Content driver abstraction**: `DocumentContentDriver` separates storage/editor format conversion from sync logic.
- **Font loading measure**: `document.fonts.ready` + `requestMeasure()` prevents stale text metrics after web font load.
- **ResizeObserver for panel resizing**: Keeps CM6 measurements in sync with layout changes from resizable panels.

---

## Issues Worth Noting for frontend-v2

1. **`useEditorCache` is dead code**: The hook exists but is not used by any component. Consider removing or documenting why it's kept.

2. **`parentScrollExtension` monkey-patching is fragile**: The temporary `posAtCoords` override is acknowledged as a known issue. frontend-v2 should either use CM6's native scroll handling or find a non-monkey-patching approach.

3. **Live preview ViewPlugin rebuilds entire visible range on every keystroke**: This is O(visible_nodes * renderers) per keystroke. For long documents with many headings/links/code blocks, this could be slow. Consider incremental decoration updates for the common case (single character insertion).

4. **No differential content update**: `dispatchSetContent` always replaces the entire document (`from: 0, to: doc.length`). For server reconciliation, a diff-based approach would produce smaller changes and preserve more editor state.

5. **`editVersion` counter is fragile**: The integer counter approach works but has subtle race conditions with async save callbacks. Consider a more robust dirty-tracking approach (e.g., comparing content hash against last-saved hash).
