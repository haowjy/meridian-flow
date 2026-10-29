# Document identity bar

Reference detail for the Editor identity surface. Read [CONTEXT.md](CONTEXT.md)
for feature-level contracts first.

## Document identity bar

`DocumentIdentityBar.tsx` is the one identity surface: a mono
path (`Unfiled › Untitled 4`) and its chips, on every document — tracked,
provisional, viewer. The Editor draws it as a band at the top of the active
tab's canvas; a document beside the chat draws it in the dock header
(`variant="header"`, `../dock/DockDocumentIdentity.tsx`), which replaces the
tab strip there, so the filename shows once. Crumb/field text is `text-sm`
to match the suggestion-popover rows; `identity-bar-geometry.ts` owns the box
constants (28px band, 22px child boxes) and the zero-layout-shift contract
between rest and edit states. Provisional docs are a *state* of the bar (italic
leaf + jade “Choose a home” chip), never separate chrome; the editor banner
slot below the toolbar belongs to draft chrome alone, and identity chrome must
never occupy it again (structural separation, 2026-07-17).

**The path navigates; it never edits.** `DocumentPath.tsx` makes each crumb a
`DrillInMenu` trigger: each crumb opens the list it sits in, with itself
highlighted. The area opens the list of areas, a folder opens its parent,
the filename opens its folder. An area not offered by the root list opens inside itself instead. The menu
highlights everything on the document's path and the folder a back row just
climbed out of. A pick opens through `useOpenDocumentInDock`, the way the
screen opens documents: the dock on Chat and Work, an Editor tab on the Editor.
Crumb menus carry no actions. A local-new or draft-only document is not in a
catalog yet, so its path is passive until it joins one. Browsable paths keep
their Radix roots and triggers mounted at rest; only the open browsing body acquires catalogs, and its initial trail
is set once that source resolves. The identity row is wrapping-first, one rule for Editor and dock: the review
controls move to a second line before anything shortens, and only a line too
narrow for them alone collapses labels to icons, hides the stepper count, then
collapses Apply to its icon; parent crumbs drop only when the leaf would be cut.
Coarse pointers give each control a 44px box and grow the row to fit, and the
filename yields its width (see [CONTEXT.md](CONTEXT.md)). Renaming and
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
- **Homed documents have no chip.** The field never opens for a homed document,
  including refusals; rename and move start and retry in the lists.
- **Commit seam**: the field submits one final `{ destination, name }` to
  `use-identity-commit.ts`. The hook resolves the stable resource handle and
  writes one durable location intent. The optimistic resource projection updates
  the tab and route immediately; the namespace runner later settles the exact
  server receipt or a typed final HTTP refusal tied to the submitted operation. A same-name explicit Save clears provisional presentation.
  Navigation additionally requires that the committed document is still active.
  The field does not blur-dismiss while a save is pending.
- **Repair receipts**: a failed placement remains `needs-repair` in the journal.
  Only a provisional draft's placement refusal reopens the identity field with
  the writer's name and recovery note, automatically or through its failure mark.
  A refused create counts: the document stays local in Unfiled and the labelled mark reads
  "Couldn't create this document. Try another place.", the same sentence as the field's note.
  The mark sits on a line of its own under the path, wrapping, so a phone-width bar never cuts
  it. Committing a home files it with a new create under the same id. A read-only bar shows
  the mark as an icon whose tooltip is that same sentence.
  Homed documents show a passive failure mark whose tooltip names the failed
  move destination (or rename) and directs retry to Move… (or Rename) in the
  file list. The mark never opens a field. Retry settles the failed attempt and
  appends a new immutable intention. Failures are never inferred from catalog absence.
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
