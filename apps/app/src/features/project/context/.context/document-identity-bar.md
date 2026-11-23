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

A review's controls sit in the toolbar row, in the place "Review N changes" holds on a plain
draft (lead's call in the #1853 review, design §6): the layout toggle on a wide pane, the
chapter's `Discard` · `Apply`, the stepper, then Close, which takes the button's place. This
reverses the owner's 2026-11-12 call to give them a line of their own so the formatting controls
stay whole; the owner has it to confirm. A pane under 720px offers Inline only, shows the short
stepper count and an icon-only Close. A draft's notice takes a line above the toolbar
(`[data-review-line]`), one rule for main and the side; it never sits in the toolbar row, which a
narrow pane can't widen. In the notice only the document's name shortens: the verb and Undo
always show. The phone's review header gives the
notice a row of its own under its first row. Coarse pointers give each control a 44px box. Renaming and
moving a homed document belong to the lists (Files, the sidebar's sources, phone
browser); see the KB's path-navigates-lists-edit page.

Contracts:

- **Keystroke path**: at rest the bar renders from document metadata only. The
  content-suggestion observer (300ms debounce, `writerOwnsName` latch) mounts
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
