# surfaces/toolbar — the persistent document toolbar

The editor's one persistent chrome row: Undo, Redo, then Heading, Bold,
Italic, Code block, Bullet list, Link, block alignment, Upload figure. It carries
document-level verbs only. `EditorSurfaceFrame` docks it above the scroll
area and `EditorView` supplies the editor and the upload callback.

## Mental model

The command layer is the module; the row renders it. `toolbar-commands.ts`
answers two questions from editor state — is this control applied, and if it
cannot run here, why — and owns the commands behind the controls.
`DocumentToolbar.tsx` renders that answer and dispatches. A control's
behavior is never decided in a component.

## Key rules

- **Fixed geometry** (ruling 15). Ten controls, always, in one order. A
  control that cannot apply greys and says why in its tooltip; it never
  disappears, moves, or gains a neighbor as the caret travels. Contextual
  verbs belong to surfaces anchored to the block that owns them, never here.
- **Greying is not `disabled`.** A disabled button leaves the hover and focus
  path, so the reason never reaches the writer. Blocked controls keep
  `aria-disabled`, keep their tooltip, and drop their action (law 5).
- **Toggles reverse** (law 6). Heading is an H1 toggle back to paragraph;
  the Code button fences a block and un-fences it (human ruling: it makes a
  ``` block, it does not format text); bullet list un-lists; marks remove. If a
  TipTap command only applies in one direction, spell out the reverse here.
- **The inline code mark is not on this row.** Its writer surfaces are Ctrl+E
  today and the formatting menu later; `toggleTextMark` keeps the command so
  those surfaces share this one.
- **Block-type commands refuse non-text targets themselves.** The greyed
  button is the first fence, the command is the second, and the second is
  load-bearing: a selected figure converting to a heading is the accident this
  module exists to make unreachable (F6). ANY protected target in the selection
  refuses the whole conversion, and protected is judged by node type, never by
  `isTextblock` — a mermaid fence and a `jsx_leaf` are both text blocks.
- **A control may not advertise what dispatch refuses.** Availability comes
  from the same predicate the command runs, and for marks that predicate is
  `editor.can().setMark`. A control that looks live and does nothing is the
  dead control law 5 forbids.
- New writer copy goes in `toolbar-copy.ts`, including every blocked reason.
  A reason code with no message is a control that greys silently. Copy reaches
  the browser through the COMPILED catalogs, so run extract and compile and
  commit both; `pnpm check:i18n` fails the build when they drift.
- Do not bind Ctrl+K to the link popover: that key belongs to the later link
  lane, which absorbs this popover.

## Anti-patterns

- Reading enablement from `editor.can()` inside a component. The matrix is
  one function; call it.
- Adding a contextual control (language selector, table verbs, alt text) to
  this row.
- Reviving `EditorLinkBubble` or any raise-on-click surface.

→ [`../../AGENTS.md`](../../AGENTS.md)
→ design of record: `editor-toolbar-split/interaction-model.md` §2 laws,
  §10 rulings 14 to 17
