# surfaces/formatting — the formatting menu

The menu a writer asks for over a selection: a quick marks row, Turn into ▸,
Add link, then Cut, Copy, Paste. Right-click and Menu key / Shift+F10 are its
two doors, and a long press arrives through the first.

## Mental model

The menu owns its triggers and its rendering, and owns no commands. Every verb
in it comes from the toolbar's command layer
([`../toolbar`](../toolbar/AGENTS.md)) so that a control here refuses exactly
what the same control refuses there, for the same reason.
`formatting-menu-items.ts` turns that layer into one model per open; the
component renders it.

Three files, three jobs:

- **`formatting-triggers.ts`** — when the menu opens and where it hangs. Two
  pure questions (is the selection prose, is the context ours) that both doors
  ask, because the right-click split matrix is a cross-lane contract worth
  testing without a pointer.
- **`useFormattingMenuDoors.ts`** — the claim and the keymap, wired to one
  `open(point)`.
- **`formatting-menu-items.ts`** — the truth table: lit, or greyed with a
  reason.

## Key rules

- **The claim is narrow, and narrow is the design.** A bare caret, a code
  fence, an object, portalled chrome, and a read-only document all keep the
  browser's menu. Ruling 11 makes that menu load-bearing: spellcheck lives
  almost entirely at the bare caret, and every rung this lane takes is one the
  writer loses.
- **Selection alone raises nothing** (ruling 13). There is no hover trigger, no
  raise-on-select, and adding one is the bubble this rebuild deleted.
- **No private gesture door.** Touch reaches this menu as a `contextmenu`
  through the kernel's ladder, never through a pointer timer of this lane's
  own: a timer cannot ask whether a link or a diagram under the finger outranks
  this rung, and it opens over a native callout it cannot suppress.
- **Both doors ask the same questions.** The keyboard twin declines wherever
  the right-click declines, through `formattingOwnsContext` and the keymap's
  `appliesTo`. A door that drifts is a split matrix that is only true for the
  mouse.
- **Never bind Escape, never listen for `contextmenu`.** The Esc chain owns the
  first and the kernel's router owns the second.
- **A greyed item keeps its hover and focus.** `aria-disabled` plus a tooltip,
  never Radix's `disabled`, which takes the reason away with the item (law 5).
- **A refusal that came from the browser still reaches the writer.** The
  clipboard can be withheld in either direction; the control greys with the
  shortcut rather than failing twice in silence.
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
`prepare`, which says where the verbs act. Adding a fourth clipboard row, or a
second reason for a refused one, is an edit here and nowhere else.
