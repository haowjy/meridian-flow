# Phase 7: Cleanup & Clipboard

## Goal

Make markers “structural only” in practice:
- Copy/cut never puts PUA markers on the clipboard
- Paste never inserts PUA markers into the editor
- Saving never persists marker characters (fail-safe)
- If marker structure is corrupted, repair by re-hydrating from the last known-good `content` + `aiVersion` (do not “best guess”).

This phase is intentionally last; it’s polish + safety hardening.

**Incremental order note:** implement **Step 7.2 (clipboard filters)** right after Phase 3, before you do heavy end-to-end testing. It prevents accidental marker spread during copy/paste while you’re iterating.

---

## What We’re Protecting Against

| Action | Bad Outcome | Fix |
|--------|------------|-----|
| Copy/cut | Clipboard contains `\uE000-\uE003` | Strip markers on clipboard output |
| Paste | Paste inserts markers → edit filter blocks paste | Strip markers on clipboard input |
| Corrupt/unknown input | Marker structure is invalid; save would be wrong | Fail fast + repair from last known-good snapshot |

---

## Steps

### Step 7.1: Add a shared sanitizer

Update `frontend/src/features/documents/utils/mergedDocument.ts`:

- `stripMarkers(text: string): string` removes all `\uE000-\uE003`
- `hasAnyMarker(text: string): boolean` to detect unexpected markers

> Note: These are now implemented in Phase 1 (`01-foundation.md`) because they are correctness-critical (they prevent marker collisions from becoming structurally ambiguous).

Keep these utilities small and reusable (clipboard + save-time safety).

---

### Step 7.2: Add clipboard filters to the diffView extension bundle

Create `frontend/src/core/editor/codemirror/diffView/clipboard.ts`:

- Clipboard output filter: `text => stripMarkers(text)`
- Clipboard input filter: `text => stripMarkers(text)`

Preferred approach (CM6): use `EditorView.clipboardOutputFilter` + `EditorView.clipboardInputFilter`.
Fallback: use `EditorView.domEventHandlers({ copy, cut, paste })`.

Update `frontend/src/core/editor/codemirror/diffView/plugin.ts` (or `index.ts`) to include the clipboard extension in `createDiffViewExtension()`.

---

### Step 7.3: Marker validation (already implemented in Phase 1)

`validateMarkerStructure()` and `DiffMarkersCorruptedError` are now implemented in Phase 1 (`01-foundation.md`) and called from `parseMergedDocument()`.

The validation uses a simple state machine over `\uE000-\uE003`:
- Outside hunk: allow text, or `DEL_START`
- In deletion: allow text, or `DEL_END`
- After deletion: must see `INS_START`
- In insertion: allow text, or `INS_END`
- End state must be outside

If any marker appears in an unexpected state, `parseMergedDocument()` throws `DiffMarkersCorruptedError`.

---

### Step 7.4: Repair strategy (preferred) + save-time safety

Update `frontend/src/features/documents/utils/saveMergedDocument.ts`:

- `parseMergedDocument()` now automatically validates and throws `DiffMarkersCorruptedError` if structure is invalid.
- Do **not** attempt to "auto-strip everything" and proceed; that risks saving the wrong `content`/`aiVersion`.

Update `frontend/src/features/documents/components/EditorPanel.tsx`:

- If autosave fails with `DiffMarkersCorruptedError`:
  - Stop the save loop (leave `hasUserEdit=true` but don’t keep retrying).
  - Show a clear banner: “Diff view corrupted — Refresh to repair (unsaved edits will be lost).”
  - Repair action: re-hydrate the editor from the last known-good snapshot:
    - Prefer `activeDocument.content` + `activeDocument.aiVersion` (or a stashed server snapshot if you have one)
    - `merged = buildMergedDocument(content, aiVersion)`
    - `setContent(merged, { addToHistory: false, emitChange: false })`

Only if repair is impossible (no snapshot) should you fall back to stripping markers and disabling diff UI (last resort).

---

## Verification Checklist (Additions)

### Malformed marker repair
- Force-corrupt marker structure (dev) → autosave halts + repair banner appears
- Click Repair → editor restores from last known-good content+aiVersion and diff view returns

---

## Verification Checklist

### Clipboard
- Copy INS text → clipboard contains no PUA markers
- Copy across a hunk boundary → clipboard contains no PUA markers
- Paste text containing PUA markers (simulate) → markers are stripped on insert

### Save safety
- If `content` or `aiVersion` contain PUA markers (legacy/AI edge case), they are stripped before building a merged doc (warn in console)
