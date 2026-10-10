# Document identity bar

Reference detail for the Editor identity surface. Read [CONTEXT.md](CONTEXT.md)
for feature-level contracts first.

## Document identity bar

`DocumentIdentityBar.tsx` is the one identity surface: a fixed-height mono
path (`Unfiled › Untitled 4`) and its chips, on every document — tracked,
provisional, viewer. The Editor draws it as a band at the top of the active
tab's canvas; a document beside the chat draws it in the dock header
(`variant="header"`, `../dock/DockDocumentIdentity.tsx`), which replaces the
tab strip there, so the filename shows once. Crumb/field text is `text-sm`
to match the suggestion-popover rows; `identity-bar-geometry.ts` owns the box
constants (26px band, 22px child boxes) and the zero-layout-shift contract
between rest and edit states. Provisional docs are a *state* of the bar (italic
leaf + jade “Choose a home” chip), never separate chrome; the editor banner
slot below the toolbar belongs to draft chrome alone, and identity chrome must
never occupy it again (structural separation, 2026-07-17).

**The path navigates; it never edits.** `DocumentPath.tsx` makes each crumb a
`DrillInMenu` trigger: the area crumb opens inside the area, a folder crumb
inside that folder, the filename inside its folder, and `…` one level above the
crumb after it (inside the folder that holds the last folder). The menu
highlights everything on the document's path and the folder a back row just
climbed out of. A pick opens through `useOpenDocumentInDock`, the way the
screen opens documents: the dock on Chat and Work, an Editor tab on the Editor.
Crumb menus carry no actions. Folders collapse into `…` only when the row is
too narrow, measured from a hidden copy of the full row; the steps are every
folder, the last folder, no folders, then the area as its icon. Renaming and
moving a homed document belong to the lists (Files, Scratch section, phone
browser); see the KB's path-navigates-lists-edit decision.

Contracts:

- **Keystroke path**: at rest the bar renders from tab metadata only. The
  content-suggestion observer (300ms debounce, `writerOwnsName` latch) mounts
  only while the edit field is open on a provisional doc.
- **Placement grammar** (any Unfiled document or provisional document): the jade chip opens
  an EMPTY field — the content-derived suggestion is ghost placeholder text
  (Tab/→ accepts it; Enter on an empty field accepts it implicitly). The
  popover opens on the scheme roots (Manuscript / Knowledge Base / User —
  the roots ARE the context choice); picking drills into folders, building the
  home as read-only spans left of the name. Enter with a home built moves
  (+renames); name-only Enter renames in place — naming isn't homing.
  Naming stays in Unfiled; filing changes source membership.
- **Homed documents have no chip.** The field still opens for a homed document
  only to repair a refused move (below); rename and move start in the lists.
- **Commit seam**: the field submits one final `{ destination, name }` to
  `use-identity-commit.ts`. The hook resolves the stable resource handle and
  writes one durable location intent. The optimistic resource projection updates
  the tab and route immediately; the namespace runner later settles the exact
  server receipt or a typed final HTTP refusal tied to the submitted operation. A same-name explicit Save clears provisional presentation.
  Navigation additionally requires that the committed document is still active.
  The field does not blur-dismiss while a save is pending.
- **Repair receipts**: a failed placement remains `needs-repair` in the journal.
  The identity field reopens with the writer's name and recovery note; retry
  settles the failed attempt and appends a new immutable intention. Failures are
  never inferred from catalog absence.
- **Field buttons**: the open field renders ✓/× icon buttons after it —
  additive mirrors of Enter/Esc (pointerdown is prevented so the blur-revert
  contract can't fire before the click lands). Keyboard behavior unchanged.
- **Chip slot**: right edge. `ChooseHomeChip` (jade) shows only while the
  document is provisional and opens empty placement; it disappears once the
  draft has a home. Uploads viewers carry no chip (no dead buttons). The device-only status (warning tokens,
  `TriangleAlert`) appears *beside* the action — quiet on its left, never in
  its place: placement commits queue durably offline, so device-only is
  exactly when the writer may want to file the document. It claims its spot
  only when local content is usable without current server authority. While the
  field is open only the
  action chip yields (the field is the action); the status stays.
- **Destination keyboard path**: ArrowDown/ArrowUp enters the suggestion list
  through its typed focus handle. Rows retain arrow wrapping and Enter select;
  folder selection can drill to arbitrary existing depth.

The tab strip still follows the settled tonal treatment: it paints nothing,
active tabs continue the canvas upward, inactive neighbors alone receive short
dividers, and the whole chip is the tab target.
