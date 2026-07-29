# surfaces/formatting — the formatting menu

The menu a writer asks for over a selection: a quick marks row, Turn into ▸,
Add link, then Cut, Copy, Paste. Right-click, Menu key / Shift+F10, and long
press are three doors into one surface.

## Mental model

The menu owns its triggers and its rendering, and owns no commands. Every verb
in it comes from the toolbar's command layer
([`../toolbar`](../toolbar/AGENTS.md)) so that a control here refuses exactly
what the same control refuses there, for the same reason. `formatting-menu-items.ts`
turns that layer into one model per open; the component renders it.

Three files, three jobs:

- **`formatting-triggers.ts`** — when the menu opens and where it hangs. Pure
  over editor state, because the right-click split matrix is a cross-lane
  contract worth testing without a pointer.
- **`useFormattingMenuDoors.ts`** — the three doors wired to one `open(point)`.
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
- **Never bind Escape, never listen for `contextmenu`.** The Esc chain owns the
  first (`mergeKeymapContributions` throws) and the kernel's claim ladder owns
  the second. Menu key and long press are this lane's because the ladder routes
  `contextmenu` only.
- **A greyed item keeps its hover and focus.** `aria-disabled` plus a tooltip,
  never Radix's `disabled`, which takes the reason away with the item (law 5).
- **Handing off to another surface waits for the prose.** Every editor surface
  returns focus on close; a form opened before that focus lands dismisses
  itself. See `.context/CONTEXT.md`.
- New copy goes in `formatting-copy.ts`, and the reasons come from
  `blockedReasonMessage` — one wording per reason across the whole toolkit.
  Run lingui extract and compile; `pnpm check:i18n` fails on drift.

## Anti-patterns

- Re-deriving what a command will refuse. Ask `blockTypeStates` /
  `textMarkState`; a menu that advertises what dispatch refuses is the dead
  control law 5 forbids.
- A second `open` path. Three doors, one call, or the surface grows three
  states that disagree.
- Claiming the right-click on anything the design did not name.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md)
→ [`../../chrome/AGENTS.md`](../../chrome/AGENTS.md) for the primitives,
  [`../../../../core/editor/chrome/.context/CONTEXT.md`](../../../../core/editor/chrome/.context/CONTEXT.md)
  for the claim ladder and the Esc chain
→ design of record: `editor-toolbar-split/interaction-model.md` §5.1, §4,
  §2 laws 5 to 7
