# Folder mentions: acceptance run on the final code

- Commit: `a9662a1bd` (`feat/folder-mentions`), run 2026-10-25.
- Stack: this checkout's `pnpm dev` restarted with `MODEL_PROVIDER=mock` (so `./mf mock`
  works and the model's input can be read back). Development client, Chromium via agent-browser.
- Viewports: 1440x900 (desktop) and 390x844 (phone). Own project (`p14973 accept`), deleted afterwards.
- Console: no errors or warnings in the session (only Vite and React DevTools info lines);
  no `catalog.folderAt is not a function`.
- Clipboard: headless Chromium has no system clipboard, so copy and paste were driven by
  dispatching `copy` and `paste` events with a `DataTransfer` into the page. ProseMirror's own
  handlers wrote and read the payload (`text/html` with `data-composer-reference`
  and `text/plain` `[Act 1](<manuscript://Act 1/>)`).

## Result: all `docs/qa/folder-mentions.md` steps pass; no blocking defect

| # | Step | Result | Screenshots |
|---|------|--------|-------------|
| 1 | Picker: Manuscript root has no Mention row | pass | `accept-01a-desktop-manuscript-root-no-mention.png` |
| 1 | Inside Act 1: first row "Mention Act 1" with folder icon; Battle (empty) listed | pass | `accept-01b-desktop-act1-mention-row.png` |
| 1 | Empty folder Battle: "Mention Battle" instead of an empty state | pass | `accept-01c-desktop-empty-battle-mention.png` |
| 1 | Typing `Op` inside Act 1 hides the Mention row | pass | `accept-01d-desktop-search-hides-mention.png` |
| 2 | Composer chip: folder icon, label "Act 1"; survives reload | pass | `accept-02a-…`, `accept-02b-…` |
| 2 | Copy/paste chip within composer: second folder chip | pass | `accept-02c-desktop-paste-in-composer.png` |
| 2 | Paste composer chip into Editor: folder icon, filled, opens inside Act; stored as `[Act 1](<../Act 1/>)` | pass | `accept-05a-…`, `accept-05b-desktop-pasted-link-menu.png` |
| 3 | Chip click opens menu inside Act 1 (Back, Battle, Opening); Battle drills ("Nothing here yet."), Back climbs to Act 1 then Manuscript; Opening opens the doc in the dock | pass | `accept-03a-…`, `accept-03b-…`, `accept-03c-…` |
| 3 | Enter on focused chip opens the same menu | pass | (snapshot) |
| 3 | Shift+F10: Edit display text / Change reference / Remove reference. The chip is a `<button>` (implicit role button) with `aria-haspopup="menu"` | pass | `accept-03d-desktop-composer-shift-f10.png` |
| 4 | Editor `@` → Act 1: folder chip; `./mf doc read` returns `Opening scene [Act 1](<../Act 1/>)`; hover tooltip "Act 1"; click opens menu below the link; Escape returns the caret to the prose | pass | `accept-04a-…` to `accept-04c-…` |
| 4 | Editor Shift+F10 menu → "Open link" opens the same drill-in menu | pass | `accept-04d-…`, `accept-04e-…` |
| 5 | Rename Act 1 → "Act One" in the sidebar: Editor and composer prose labels stay "Act 1"; hover reads "Act One"; menu header "Act One"; stored link becomes `<../Act One/>` | pass | `accept-07a-…`, `accept-07b-…`, `accept-07c-…` |
| 6 | Send with folder chip: transcript chip has the folder icon, click opens the menu inside the folder | pass | `accept-06a-…`, `accept-06b-…`, `accept-06c-…` |
| 6 | Move Act One into Act (sidebar Move…): transcript and Editor chips open at the current location (Back goes to Act, which lists Act One and Inner); sent text unchanged | pass | `accept-08a-…`, `accept-08b-…`, `accept-08c-…` |
| 6 | `./mf thread context`: user message holds `[Act 1](<manuscript://Act 1/>)` after rename and move; `./mf thread view --json`: `readDocuments` is 0 | pass | n/a |
| 6 | Transcript chip Shift+F10 opens a context menu | pass with note 1 | `accept-08d-desktop-transcript-shift-f10.png` |
| 6 | Delete Act One: transcript chip turns dashed, `aria-description="No longer available"`, click opens nothing | pass with note 2 | `accept-10a-…`, `accept-10b-…`, `accept-10c-…` |
| 7 | Composer chip for a deleted folder: menu says "This folder is no longer available." | pass | `accept-11a-desktop-deleted-folder-open-menu.png` |
| 8 | Foreign Work's Scratch folder link: filled folder chip, no console error; after the Work is deleted (no reload) the chip turns dashed | pass | `accept-12a-…`, `accept-12b-desktop-foreign-folder-link-gone.png` |
| 9 | Server identity boundaries (CLI): holder rewritten to `Folder Probe Renamed/`; relative resolve returns the folder state; 129 distinct identities return 129 `gone` | pass | n/a |
| rel | Relative links from a doc inside Act/Act One/Battle: `../` → Act One, `../../` → Act, `./` → Battle (empty folder menu), `../Opening.md` → document (opens it) | pass | `accept-09e-desktop-relative-self-folder-menu.png` |
| stem | Same-stem: see note 3. In `Probe`: `Act/` is a filled folder; `Scene.md` is a document chip; `Scene/` and `Act` (no slash) are dashed | pass | `accept-09a-…`, `accept-09b-desktop-folder-act-menu.png`, `accept-09c-…`, `accept-09d-…` |
| phone | 390x844: picker Mention row, composer chip menu, edit menu, transcript chip menu, Editor link menu all fit the viewport | pass | `accept-14a-…` to `accept-14e-…` |
| model | Mock model reply seen; message text sent as the Markdown link; nothing inlined | pass | n/a |

## Document mentions (regression): behave as before

| Check | Result | Screenshot |
|-------|--------|-----------|
| Composer document chip: manuscript icon; click opens the document in the dock | pass | `accept-13a-desktop-doc-chip-click.png` |
| Transcript document chip is a link span, click opens the document; Shift+F10 shows title, address and "Open link" | pass | `accept-13b-…`, `accept-13c-…` |
| Rename document: transcript label unchanged, click opens the renamed document | pass | `accept-13d-desktop-doc-chip-after-rename.png` |
| Delete document: chip turns dashed ("No longer available"), no hover card | pass | `accept-13e-desktop-doc-chip-deleted.png` |
| Editor document links (`Doc Scene`, `../Opening.md`): filled, click opens the document | pass | `accept-09a-…` |

## Notes (observations, none blocking)

1. **Folder chip's context menu in the transcript is header-only.** Shift+F10 on a sent folder
   chip opens a menu with just the title and the send-time address (`manuscript://Act 1` after the
   folder was renamed and moved) and no actionable item. The document chip's menu has "Open link".
   After a document rename the document chip's menu also loses "Open link" and shows the stale
   address, so the folder behaviour matches the document one. Whether a header-only menu is the
   intended result is for the owner.
2. **Deleted composer chip stays filled.** A composer chip for a folder deleted from the sidebar
   still looks filled until clicked (the menu then says it is unavailable). The transcript chip does
   go dashed. The QA doc only asks for the menu text.
3. **Same-stem collision cannot be built.** A folder `Act` and document `Act.md` cannot coexist: the
   create call answers "already exists" in either order (an emptied folder also keeps its name). So
   the recipe case "`Act/` with `Act.md` beside it" was tested as: folder link `Act/` resolves to the
   folder, `Act` / `Act.md` to a document and a link to the missing kind is dashed.
4. **Pasting at the very end of a link merges into it.** Pasting a chip with the caret directly after
   an Editor link extends that link (`[Act 1Act 1](<../Act 1/>)`); typing exits the link, pasting
   does not. Not folder-specific (the pasted run takes the link mark), but easy to hit in the paste
   check. Pasting after typed text works.
5. **Chat titles are raw Markdown for any mention**: `[Act 1](<manuscript://Act 1/>) what is…`,
   and `[Chapter 1](<manuscript://Chapter 1>)…` for a document. Pre-existing, same for both kinds.
6. **Phone pager.** Twice, opening a document from the phone sidebar left the chat and Editor
   panels stuck half-slid (editor at x=368 and later x=-215) until a reload. Not folder-related
   and not reproduced after the reload; possibly headless-only.
7. **Recipe step 9's last `jq` fails**: `jq '.answers | {length, states: …}'` errors because `length`
   is read from an array (`Cannot index array with string "length"`). Use
   `jq -c '{length:(.answers|length), states:(.answers|group_by(.state)|map({state:.[0].state,count:length}))}'`.
8. Also seen when seeding: `./mf seed` needs `MODEL_PROVIDER=mock` (`The server has no scriptable
   mock model` on the default dev provider), and the failed attempt still created an empty
   "mf seed: basic" thread.
