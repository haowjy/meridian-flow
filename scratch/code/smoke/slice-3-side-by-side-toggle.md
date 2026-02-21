# Smoke Test: Slice 3 — Side-by-Side Toggle + Chunk Navigation

## What to verify

These are manual browser smoke tests for the Phase 5 Slice 3 changes.
All require an active document with at least one pending AI proposal.

---

## 1. Toggle button renders

1. Open a document in the editor
2. Open the AI Proposal Review Panel (right panel)
3. Confirm a toggle button is visible in the panel header showing `⇔ Split`

**Expected**: Button appears to the right of "AI Proposals (N)" title.

---

## 2. Toggle switches mode

1. Click `⇔ Split`
2. **Expected**: Button label changes to `≡ Inline`; the diff view remounts as a side-by-side MergeView with two panes

3. Click `≡ Inline`
4. **Expected**: Button label changes back to `⇔ Split`; view remounts as the unified inline diff

---

## 3. Mode is not persisted

1. Switch to split mode
2. Refresh the page
3. **Expected**: Panel loads back in unified (inline) mode — button shows `⇔ Split`

---

## 4. Split view renders changeset-derived diffs

1. With a pending proposal, switch to split mode
2. **Expected**:
   - Left pane = base text (original), right pane = proposed text
   - Changed regions are highlighted
   - Accept (✓ Accept) and Reject (✗ Reject) buttons appear in the gutter between panes

---

## 5. Accept/Reject in split mode

1. In split mode, click `✓ Accept` on a chunk
2. **Expected**: Proposal is accepted (same behavior as unified mode — proposal-level accept via server)

3. In split mode, click `✗ Reject` on a chunk
4. **Expected**: Proposal is rejected

---

## 6. Unified view keyboard navigation (Ctrl-] / Ctrl-[)

1. Switch to unified (inline) mode
2. Click into the diff view to focus it
3. Press `Ctrl-]`
4. **Expected**: Browser console shows `[chunk-nav] focused chunk index: 1 <chunk-id>` (or stays at 0 if only 1 chunk)

5. Press `Ctrl-[`
6. **Expected**: Console shows index going back to 0

---

## 7. Unified view keyboard accept/reject (Ctrl-Enter / Ctrl-Backspace)

1. In unified mode with focused chunk at index 0
2. Press `Ctrl-Enter`
3. **Expected**: Proposal accept fires (same as clicking ✓ Accept)

4. Press `Ctrl-Backspace`
5. **Expected**: Proposal reject fires (same as clicking ✗ Reject)

---

## 8. Mode switch preserves proposal state

1. Accept or reject a proposal in unified mode
2. Switch to split mode
3. **Expected**: The remaining proposals render correctly in split view (accepted/rejected ones are gone)
