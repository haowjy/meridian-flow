# Mention-drop gap probe

Checkout `feat/drag-mentions` at `d7d1d4b47`. App `https://drag-mentions.app.meridian.localhost`. Viewport 1440×900 unless noted. Browser session `p14957-probe-drop`. Seeded project **Probe drop p14957** `42d22107-514f-48b9-aa7d-d570b63994ed` (deleted after the run). Date 2026-10-25.

Stack tmux `meridian-drag-mentions-937434ed` already served this worktree (Vite cwd = checkout; no restart). Native mouse drags as in `docs/qa/row-drag.md` / `before-2b/notes.md`. OS image used a synthetic `DataTransfer` + `File` (no real OS drag).

## Results

| # | Case | Verdict |
|---|---|---|
| 1 | Drop inside a table cell | **Pass** |
| 1 | Drop on a cell seam | **Pass** |
| 2 | Asset row into the editor vs `@` | **Pass** |
| 3 | Read-only archived editor | **Pass** |
| 4 | OS image file still uploads | **Pass** (synthetic File) |
| 5 | Block-handle paragraph move | **Pass** |
| 5 | Internal text-selection drag | **Pass** |
| 6 | Tree row move + notice | **Pass** |
| 7 | Folder row | **Pass** (no insert; hint not seen) |
| 7 | Other Work's Scratch into this chat's composer | **Pass** (no insert; hint not seen) |
| 8 | Phone shell 390×844 coarse | **Pass** |
| 8 | 390×844 fine pointer | Observation, not a fail |

No app console errors. `agent-browser errors` recorded one `TypeError: e.target.getAttribute is not a function` from this probe's capture-phase drag logger, not the app. Console otherwise: Vite `connecting...` and the React DevTools line.

Pointer hints (**Mention**, **Can't mention that**) did not appear in headless screenshots, matching `before-2b/notes.md`. Refusal is judged by no content change and a `drop` that inserted nothing.

## 1. Table

Inserted a 3×3 table in `chapter-2` via `/table`. Typed `cellword` in the first body cell.

**Inside the cell.** Dragged `chapter-1` onto the middle of `cellword`. After drop the cell was `chapter-1 cellword` (filled manuscript chip, `data-meridian-link="manuscript://Act 1/chapter-1"`). Word-snapped to the nearer edge. Table stayed 3×3. MIME on drop: `application/x-meridian-entries`. No move notice.

- Before: `probe-01-table-before.png`
- After: `probe-03-table-cell-after.png`

**Seam.** Dragged `chapter-3` onto the vertical border between that cell and the empty cell to its right (`clientX=824`). Chip landed in the same cell (`chapter-1 cellword chapter-3`). Still 3×3. Did not create a column. Did not swallow silently.

- After: `probe-05-table-seam-after.png`

## 2. Asset row vs `@`

**OS image first** (also case 4): synthetic `DataTransfer` with `/tmp/p14957-gate.png` (64×32 PNG) dispatched `dragenter`/`dragover`/`drop` on the last paragraph. The editor uploaded it and inserted a framed image (`alt="p14957 gate"`, object-store URL). An `assets` folder appeared with row `10504a04-d950-4694-9bc9-e13bcc48f7e1-p14957-gate.png` (`file:5b6e7b70-e110-4471-a58f-838d02f6d4f4`).

- `probe-06-os-image-after.png`

**`@` on that row** inserted an unframed image node with `alt` = the filename, not a mention chip.

- `probe-07-at-asset-insert.png`

**Dragging that asset row** into the Mara paragraph inserted the same unframed image node (`alt` = filename), word-snapped between `wall` and `until`. Not a chip. No move notice.

- `probe-09-asset-row-after.png`

## 3. Read-only (archived Work)

Work **Archive probe** `w2` archived via `POST /api/works/…/archive`. Opened `scratch://@w2/archived-note` in the Work Files rail and in the full Editor tab.

`contenteditable="false"`. Banner **This Work is archived.** Drag of `chapter-1` over the body: no drop caret, no hint, no copy cursor, HTML stayed `<p>This note should be read-only after archive.</p>`. No chips. No move notice. In the full Editor, `dragenter` hit the paragraph and `dragend` fired without a `drop`.

- Rail: `probe-10-archived-open.png`, `probe-12-archived-after.png`
- Editor: `probe-13-archived-editor.png`, `probe-15-archived-editor-after.png`

Incidental: the archived Editor tab showed **Saved locally (offline)** once.

## 4. OS image regression

Covered above. Method: synthetic `DataTransfer` + `File` (`image/png`), not a real OS drag. Upload and insert succeeded.

## 5. Block drag and text drag

**Block handle.** Hovered left of **The valley held its breath.**, pressed **Move or change this block**, dragged down past Mara. Valley moved from above the table to between Mara and the last paragraph.

- Before: `probe-16-block-before.png`
- After: `probe-18-block-after.png`

**Text selection.** Selected `counted the stones` in Mara and dragged it into Valley. Mara lost the words; Valley became `The valley held its brecounted the stonesath.` Existing mid-word landing; the mention-drop lane did not steal `view.dragging`.

- `probe-21-text-after.png`

## 6. Tree move (2a)

Dragged `chapter-3` onto the `assets` folder. Row arrived under `assets`. Notice **Moved chapter-3 to assets.** with Undo and Dismiss. Overlay count 0.

- `probe-23-tree-move-after.png`

## 7. Folder and foreign Scratch

**Folder `Act 1`.** Drag onto the Chapter notes composer left `Please read  this.` unchanged. Drag onto the editor body fired `drop` on the paragraph with `application/x-meridian-entries` and inserted nothing. Folder stayed in Manuscript. No move notice. Hint label **Can't mention that** was not visible in this headless session.

- `probe-25-folder-composer-after.png`, `probe-27-folder-editor-hover.png`

**Other Work's Scratch.** With Chapter notes still in the dock, opened Work **Other scratch** → Files and dragged `foreign-note` onto the composer (`drop` at 1260,815 on the composer `<p>`). Composer HTML stayed `<p>Please read  this.</p>`. No chip, no move. Same headless gap on the hint.

- `probe-29-foreign-composer-after.png`

The `@` menu on this chat did list **Other scratch** as a drill row; the foreign *file* still did not resolve into a composer chip on drop.

## 8. Phone

**390×844, fine pointer** (`agent-browser set device "iPhone 14"` did not set `pointer: coarse`). Desktop shell, sidebar collapsed. Rows still `draggable="true"`. Document still rendered (table, chips, images). `probe-30-phone.png`.

**390×844, coarse pointer** (CDP `Emulation.setEmulatedMedia` + touch + `setDeviceMetricsOverride`, then reload). `data-phone-shell="true"`, **Open navigation** present. After opening nav, every `[data-entry-key]` had `draggable="false"`. No block handles. Nothing broken.

- `probe-31-phone-nav.png`

Row drag is gated on `usePhoneShell()` (`(pointer: coarse)` and a phone-sized viewport), not width alone. A 390px desktop window still drags.

## Console

- Vite connecting, React DevTools info.
- One `TypeError` from the probe's drag logger (`e.target.getAttribute` when `target` was not an Element). Not product code.

## Cleanup

Browser session `p14957-probe-drop` closed. Seeded project deleted. Dev stack left running.
