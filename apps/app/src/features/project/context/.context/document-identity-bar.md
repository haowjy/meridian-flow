# Document identity bar

Reference detail for the Editor identity surface. Read [CONTEXT.md](CONTEXT.md)
for feature-level contracts first.

## Document identity bar

`DocumentIdentityBar.tsx` is the one identity surface: a mono
path (`Unfiled › Untitled 4`) and its chips, on every document — tracked,
provisional, viewer. Every host draws it (`variant="state"`) at the top of
its document's canvas, in main and in the side. The header above it
(`MainHeader`, `SideDocumentHeader`) carries the document's name, so the bar shows
the path and chips. Crumb/field text is `text-sm`
to match the suggestion-popover rows; `identity-bar-geometry.ts` owns the box
constants (28px band, 22px child boxes) and the zero-layout-shift contract
between rest and edit states. Provisional docs are a *state* of the bar (italic
leaf + jade “Choose a home” chip), never separate chrome; the editor banner
slot below the toolbar belongs to draft chrome alone, and identity chrome must
never occupy it again (structural separation, 2026-07-17).

A review's controls take the formatting toolbar's place in the toolbar row
(`DocumentToolbarPortal`), one rule for main and the side, and the row takes the review tint. The
owner first kept them on a line above the toolbar (2026-11-12) so the formatting controls stayed
whole; mockup round 2 (2026-11-22) and the UX lead's call on #1881 replaced that: three stacked
bars cost writing space, and the shortcuts still work with the buttons gone. Close is
`ReviewChangesButton` in Review changes, in the state slot where `Review N changes` was. The bar
holds the target picker, the layout toggle (a pane of 680px or more; a narrower one offers Inline
only), the stepper, and the chapter's × and ✓. A bar too narrow gives up in steps (`fitReviewLine`
in `features/draft-review/ReviewBar.tsx`, `review-line.css`): the short count and tighter gaps,
then no count, then (a finger only) the stepper. A cut picker name counts as not fitting only
until the count is gone: only an overflow hides the stepper. The phone's review row uses the same
bar and the same labelled Close. A page's notice (`PageNotice`) floats at the page's foot,
never in a row, so nothing moves when it comes or goes; on a narrow page it sits above the word
count. Coarse pointers give each control a 44px box. Renaming and
moving a homed document belong to the lists (Files, the sidebar's sources, phone
browser); see the KB's path-navigates-lists-edit page.

Contracts:

- **Keystroke path**: at rest the bar renders from document metadata only. The
  content-suggestion observer (300ms debounce) mounts
  only while the edit field is open on a provisional doc.
- **Placement grammar** (any Unfiled document or provisional document): the jade chip opens
  an EMPTY field — the content-derived suggestion is ghost placeholder text
  (Tab/→ accepts it; Enter on an empty field accepts it implicitly). The
  popover opens on the scheme roots (Manuscript / Knowledge / User —
  the roots ARE the context choice); picking drills into folders, building the
  home as read-only spans left of the name. Enter with a home built moves
  (+renames); name-only Enter renames in place — naming isn't homing.
  Naming stays in Unfiled; filing changes source membership.
- **Homed documents have no chip.** The field never opens for a homed document,
  including refusals; rename and move start and retry in the lists.
- **Commit seam**: the field submits one final `{ destination, name }` to
  `use-identity-commit.ts`. The hook finds the document's node and the destination folder (or
  the source's top) in the replay, then appends a `move` and a `rename` record to the browser's
  copy of the list through `useTreeActions`. The replay updates the host's descriptor and route
  at once, and the commit reports the name the writer typed (beside a sibling of that name it is a twin).
  A same-name explicit Save clears provisional presentation. Navigation additionally requires
  that the committed document is still active. The field does not blur-dismiss while a save is
  pending. A move between a project and the account's files is a server route, not offered here.
- **Field buttons**: the open field renders ✓/× icon buttons after it —
  additive mirrors of Enter/Esc (pointerdown is prevented so the blur-revert
  contract can't fire before the click lands). Keyboard behavior unchanged.
- **Chip slot**: right edge. `ChooseHomeChip` (jade) shows only while the
  document is provisional and opens empty placement; it disappears once the
  draft has a home. Uploads viewers carry no chip (no dead buttons). The device-only status (warning tokens,
  `TriangleAlert`) appears *beside* the action — quiet on its left, never in
  its place: placement records queue durably offline, so device-only is
  exactly when the writer may want to file the document. It claims its spot
  once the project's list has been offline for two seconds. While the
  field is open only the
  action chip yields (the field is the action); the status stays.
- **Destination keyboard path**: ArrowDown/ArrowUp enters the suggestion list
  through its typed focus handle. Rows retain arrow wrapping and Enter select;
  folder selection can drill to arbitrary existing depth.
