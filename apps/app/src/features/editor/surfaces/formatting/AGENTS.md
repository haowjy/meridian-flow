# surfaces/formatting — the formatting menu

The menu a writer asks for in the prose: a quick marks row, Turn into ▸, Add
link, then Cut, Copy, Paste. Right-click and Menu key / Shift+F10 are its two
doors, and a long press arrives through the first.

## Mental model

The menu owns its triggers and its rendering, and owns no commands. Every verb
in it comes from the toolbar's command layer
([`../toolbar`](../toolbar/AGENTS.md)) so that a control here refuses exactly
what the same control refuses there, for the same reason.
`formatting-menu-items.ts` turns that layer into one model per open; the
component renders it.

Three files, three jobs:

- **`formatting-triggers.ts`** — when the menu opens and where it hangs. The
  pure questions both doors ask, because the right-click split matrix is a
  cross-lane contract worth testing without a pointer.
- **`useFormattingMenuDoors.ts`** — the claim and the keymap, wired to one
  `open(point)`.
- **`formatting-menu-items.ts`** — the truth table: lit, or greyed with a
  reason.

## Key rules

- **Two rungs, one menu.** `text-selection` is a sweep the pointer is inside;
  `caret` is the ladder's floor and takes every other right-click in prose
  (human ruling, 2026-07-29). A code fence, an object, portalled chrome, and a
  read-only document still decline, and Shift+right-click never reaches this
  lane at all — the kernel answers it above the ladder.
- **The caret rung moves the caret before it opens.** Turn into converts the
  block the selection is in, so a menu over the third paragraph must not offer
  to convert the first. `placeCaretForMenu` is that dispatch and it is
  synchronous, inside the claim.
- **In a table the menu carries the grips' own lists.** `TableCaretMenuItems`
  from [`../table`](../table/AGENTS.md), never a third copy of the verbs: a
  writer who found the row grip and a writer who right-clicked a cell meet the
  same rows in the same order.
- **Selection alone raises nothing** (ruling 13). There is no hover trigger, no
  raise-on-select, and adding one is the bubble this rebuild deleted.
- **No private gesture door.** Touch reaches this menu as a `contextmenu`
  through the kernel's ladder, never through a pointer timer of this lane's
  own: a timer cannot ask whether a link or a diagram under the finger outranks
  this rung, and it opens over a native callout it cannot suppress.
- **The keyboard twin owns the selection door only.** It declines wherever the
  right-click's `text-selection` rung declines, through `formattingOwnsContext`
  and the keymap's `appliesTo`. It has no caret rung: Shift+F10 has no pointer,
  so there is nowhere to move a caret to.
- **Never bind Escape, never listen for `contextmenu`.** The Esc chain owns the
  first and the kernel's router owns the second.
- **A greyed item keeps its hover and focus** and shows its label alone; the
  reason arrives from the shared row's tooltip, which is why the row may never
  take Radix's `disabled` (law 5). Pass `blockedReason`; wire nothing else.
- **A refusal that came from the browser still reaches the writer.** The
  clipboard can be withheld in either direction; the control greys with the
  shortcut rather than failing twice in silence, and it greys where the writer
  pressed it — a clipboard row keeps the menu open until its verb settles, so a
  refusal has a row left to be drawn on. Whether it was withheld, and
  which refusal it was, comes from the feature's one clipboard boundary
  (`features/editor/clipboard.ts`). What this lane owns is the document half:
  what a selection serializes to, when a cut may delete, and where a paste
  lands.
- New copy goes in `formatting-copy.ts`, and the reasons come from
  `blockedReasonMessage` — one wording per reason across the whole toolkit.
  Run lingui extract and compile; `pnpm check:i18n` fails on drift.

## Anti-patterns

- Re-deriving what a command will refuse. Ask `blockTypeStates` /
  `textMarkState`; a menu that advertises what dispatch refuses is the dead
  control law 5 forbids.
- A second `open` path, or a door that answers a question the other one does
  not.
- Claiming the right-click on anything the design did not name.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md)
→ [`../../chrome/AGENTS.md`](../../chrome/AGENTS.md) for the primitives,
  [`../../../../core/editor/chrome/.context/CONTEXT.md`](../../../../core/editor/chrome/.context/CONTEXT.md)
  for the claim ladder and the Esc chain
→ design of record: `editor-toolbar-split/interaction-model.md` §5.1, §4,
  §2 laws 5 to 8

## The clipboard block is shared

Cut, Copy, and Paste live in [`clipboard-menu.tsx`](clipboard-menu.tsx) and are
mounted by this menu and by the link menu (§5.5, mockup 06 state C). The state,
the wording, the shortcut, and the greying are one answer; a menu supplies only
`prepare`, which says where the verbs act, and `closeMenu`, which says how that
menu goes away once a verb has run. Adding a fourth clipboard row, or a
second reason for a refused one, is an edit here and nowhere else.
