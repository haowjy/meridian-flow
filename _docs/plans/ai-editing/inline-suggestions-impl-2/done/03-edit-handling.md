# Phase 3: Edit Handling

## Goal

Block user edits that would corrupt the merged document structure:
1. **Never allow user edits to touch marker characters** (`\uE000-\uE003`)
2. **Block edits inside deletion regions** (original text is read-only)

Accept/reject operations bypass filters by dispatching transactions with `filter: false`.

## What You're Building

A transaction filter that:
1. **Blocks edits that touch markers** so users can’t delete/move invisible marker chars by accident
2. **Blocks edits in DEL regions** (original text is read-only)
3. **Allows edits everywhere else** (INS regions and outside hunks)

That's it. No position mapping, no dual-doc sync. The merged document IS the source of truth.

```
User types in editor
       │
       ▼
┌──────────────────────────────┐
│   Is cursor in DEL region?   │
└──────────────────────────────┘
       │
       ├─── YES ──► BLOCK (return [])
       │
       └─── NO ───► ALLOW (return tr)
```

## Why So Simple?

With PUA markers, the document contains everything:
- DEL regions = original text (read-only)
- INS regions = AI text (editable)
- Outside hunks = shared text (editable)

When the user edits:
- **In INS region**: Modifies AI suggestion → changes merged doc directly
- **Outside hunks**: Modifies shared text → changes merged doc directly
- **In DEL region**: BLOCKED → can't modify original text

On save, we parse the merged document back to `content` and `aiVersion`.

## UX for Blocked Edits (required)

Blocked edits should not feel like “the editor is broken”.

Minimum behavior:
- If an edit is blocked because it touches a DEL region (read-only original text), show a small toast/banner message like: “Can’t edit deleted text. Accept or reject the change first.”
- This also applies to formatting commands that span a DEL region.

## Steps

### Step 3.1: Create the edit filter

Create `frontend/src/core/editor/codemirror/diffView/editFilter.ts`:

```typescript
/**
 * Edit Filter for Diff View
 *
 * Blocks edits that would corrupt merged-doc structure:
 * - Never allow edits that touch marker characters
 * - Block edits inside deletion regions (original text is read-only)
 */

import { EditorState } from '@codemirror/state'
import { MARKERS, extractHunks } from '@/features/documents/utils/mergedDocument'

function containsAnyMarker(text: string): boolean {
  return (
    text.includes(MARKERS.DEL_START) ||
    text.includes(MARKERS.DEL_END) ||
    text.includes(MARKERS.INS_START) ||
    text.includes(MARKERS.INS_END)
  )
}

/**
 * Transaction filter for merged-doc safety.
 */
export const diffEditFilter = EditorState.transactionFilter.of((tr) => {
  // Pass through non-editing transactions
  if (!tr.docChanged) {
    return tr
  }

  // Get current document
  const doc = tr.startState.doc.toString()

  // If no markers at all, nothing to protect.
  if (!containsAnyMarker(doc)) return tr

  // IMPORTANT: derive hunks from the current merged doc, not from React state.
  // Hunks are cheap to extract because they are marker-based O(n) scans,
  // not a diff of content vs aiVersion.
  const hunks = extractHunks(doc)

  // Check each change in the transaction
  let shouldBlock = false

  tr.changes.iterChanges((fromA, toA, _fromB, _toB, _inserted) => {
    const replacedText = doc.slice(fromA, toA)
    const insertedText = _inserted.toString()

    // 1) Never allow marker chars to be inserted/removed/edited by the user.
    // Markers are hidden visually but still exist in the document.
    if (containsAnyMarker(replacedText) || containsAnyMarker(insertedText)) {
      shouldBlock = true
      return
    }

    // 2) Block edits that overlap deletion regions (original text).
    // Any overlap with the deletion region blocks the edit.
    // Deletion region includes the marker chars + deleted text, but marker chars
    // are already blocked above—this catches inserts inside deletedText.
    for (const hunk of hunks) {
      if (fromA <= hunk.delEnd && toA >= hunk.delStart) {
        shouldBlock = true
        return
      }

      // 3) Preserve hunk structure: DEL_END must be immediately followed by INS_START.
      // Inserting at `insStart` would place text between DEL_END and INS_START, which breaks
      // hunk extraction (and is rejected by validateMarkerStructure in Phase 1).
      if (fromA === toA && fromA === hunk.insStart) {
        shouldBlock = true
        return
      }
    }
  })

  // Block if any edit touched a deletion region
  if (shouldBlock) {
    return []  // Cancel the transaction
  }

  return tr
})
```

---

### Step 3.2: Add the filter to the extension bundle

Update `frontend/src/core/editor/codemirror/diffView/plugin.ts`:

Add the import at the top:
```typescript
import { diffEditFilter } from './editFilter'
```

Update `createDiffViewExtension`:
```typescript
export function createDiffViewExtension(): Extension {
  return [
    diffViewPlugin,
    diffEditFilter,  // Add this line
    // Keymap will be added in Phase 5
  ]
}
```

---

### Step 3.3: Update the index.ts exports

Update `frontend/src/core/editor/codemirror/diffView/index.ts`:

```typescript
/**
 * Diff View Extension
 *
 * Provides PUA marker-based diff display for AI suggestions.
 * - Hides PUA markers from display
 * - Styles deletion regions as red strikethrough
 * - Styles insertion regions as green underline
 * - Blocks edits in deletion regions
 */

// Plugin and extension
export { diffViewPlugin, createDiffViewExtension } from './plugin'

// Edit filter (auto-included in extension, exported for testing)
export { diffEditFilter } from './editFilter'
```

---

### Step 3.4: Test the edit handling

Test scenarios to verify:

**Test 1: Edit in insertion (green) region**
- Click inside green underlined text
- Type some characters
- ✅ Should succeed, text appears in green region

**Test 2: Edit in deletion (red) region**
- Try to click inside red strikethrough text
- Try to type or delete
- ✅ Typing/deleting should be blocked (note: a transaction filter blocks edits, not cursor movement)

**Test 3: Edit outside hunks**
- Click in unchanged text area
- Type some characters
- ✅ Should succeed, text appears normally

**Test 4: Select across regions**
- Select text that spans from outside into a deletion
- Try to delete or type
- ✅ Should be blocked

```typescript
// Test code for console
const content = "She felt sad. The rain fell."
const aiVersion = "A heavy melancholia. The rain continued."
const merged = buildMergedDocument(content, aiVersion)

console.log('Merged document:', JSON.stringify(merged))

// Load into editor, try these scenarios:
// 1. Click in "A heavy melancholia" → should allow edits
// 2. Click in "She felt sad" → should block edits
// 3. Click in "The rain" → should allow edits
```

---

## Understanding the Architecture

```
┌───────────────────────────────────────────────────────────────────┐
│  Merged Document in Editor                                        │
│                                                                   │
│  "\uE000She felt sad.\uE001\uE002A heavy melancholia.\uE003..."   │
│   ├── DEL region (blocked) ──┤├── INS region (editable) ──┤      │
└───────────────────────────────────────────────────────────────────┘
                    │
                    ▼
         User tries to edit
                    │
                    ▼
    ┌───────────────────────────────┐
    │  diffEditFilter intercepts    │
    └───────────────────────────────┘
                    │
         ┌──────────┴──────────┐
         │                     │
    In DEL region?        Not in DEL?
         │                     │
         ▼                     ▼
      BLOCK               ALLOW
    (return [])          (return tr)
```

**Key insight**: The filter only needs to check if the edit touches a DEL region. Everything else is allowed because the merged document handles it correctly.

---

## Edge Cases Handled

### 1. Cursor at DEL_START marker
Position is considered "inside" DEL region → blocked.

### 2. Cursor at DEL_END marker
Position is considered "outside" DEL region (just after the marker) → allowed.

### 3. Selection spanning DEL and INS
Any overlap with DEL region → blocked.

### 4. Paste that would land in DEL
Same rule: if paste range touches DEL → blocked.

### 5. Multi-cursor with one cursor in DEL
The entire transaction is blocked (safe behavior).

---

## Performance Note

The `isInDeletionRegion` function scans from the start of the document to the position. For very large documents with many hunks, this could be slow.

**Optimization if needed**: build an interval index once per transaction (we already do `extractHunks(doc)` once above), or cache hunks in the CM6 plugin and read them from state. But for typical document sizes (< 100KB) and typical hunk counts (< 50), re-extracting marker-based hunks per edit is fine.

---

## Verification Checklist

Before moving to Phase 4, verify:

- [ ] `editFilter.ts` created with transaction filter
- [ ] Extension bundle updated to include edit filter
- [ ] Edits in green (INS) regions work normally
- [ ] Edits in red (DEL) regions are blocked
- [ ] Edits outside hunks work normally
- [ ] Selection spanning DEL region is blocked
- [ ] Undo/redo still work for allowed edits

## Troubleshooting

**Edits not being blocked?**
1. Verify document contains DEL markers (`\uE000`)
2. Log the from/to positions and check against marker positions

**All edits blocked?**
1. Check the marker positions are correct
2. Verify `isInDeletionRegion` logic for edge cases
3. Log `shouldBlock` and the positions being checked

**Cursor enters DEL region?**
The edit filter only blocks changes, not cursor movement. Users can navigate into DEL regions but can't modify them. This is intentional - they might want to copy text.

## Files Created/Modified

| File | Action |
|------|--------|
| `frontend/src/core/editor/codemirror/diffView/editFilter.ts` | Created |
| `frontend/src/core/editor/codemirror/diffView/plugin.ts` | Modified |
| `frontend/src/core/editor/codemirror/diffView/index.ts` | Modified |

## Related: Blocked Edit Feedback

See `03a-blocked-edit-feedback.md` for implementing toast notifications when edits are blocked.

## Next Step

Recommended now: implement clipboard sanitization (see `07-cleanup-and-clipboard.md` Step 7.2).

Then continue to `04-state-sync.md` to implement save logic that parses the merged document.
