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

**That layer is shared.** The formatting menu carries the same marks and the
same block conversions, so it reads `textMarkState`, `blockTypeStates`,
`turnIntoBlockType`, and `blockedReasonMessage` from here rather than growing a
second answer to "will this be refused". A surface that needs a verb this
module does not expose extends it; it never forks the fence. The link form is
not part of that layer: it belongs to `surfaces/link/`, and both this row and
the formatting menu open it by calling `openLinkForm` from
`core/editor/links`.

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
- **The inline code mark is not on this row**, and neither is strikethrough or
  seven of the eight block types. Their writer surface is the formatting menu;
  the commands live here so both surfaces share one fence.
- **The greying reason comes from the chrome kernel, not from the selection.**
  `resolveChromeContext` already answers "what is the selection standing
  inside" for the Esc chain and the context-menu router; the fence reads that
  answer as a reason, so a caret in a diagram nested in a table cell greys with
  the DIAGRAM's reason and a selected table greys as an object rather than as
  one of its cells. Only where the document itself owns the context does what
  the selection SPANS decide, and then each block is read through the same
  resolver. Inspecting the selection here a second time is a second answer to a
  question the kernel already answers.
- **Block-type commands refuse non-text targets themselves.** The greyed
  button is the first fence, the command is the second, and the second is
  load-bearing: a selected figure converting to a heading is the accident this
  module exists to make unreachable (F6). ANY protected target in the selection
  refuses the whole conversion. A RENDERED object fence reads as an embedded
  block rather than a code block, so the two commands a plain fence reverses
  (un-fence, turn into paragraph) refuse it too: un-fencing a diagram destroys
  it the way converting one to a heading does.
- **A control may not advertise what dispatch refuses.** Availability comes
  from the same predicate the command runs, and for marks that predicate is
  `editor.can().setMark`. A control that looks live and does nothing is the
  dead control law 5 forbids.
- New writer copy goes in `toolbar-copy.ts`, including every blocked reason.
  A reason code with no message is a control that greys silently. Copy reaches
  the browser through the COMPILED catalogs, so run extract and compile and
  commit both; `pnpm check:i18n` fails the build when they drift.
- **The Link button opens someone else's surface.** The link form belongs to
  `surfaces/link/`, hangs at the writer's own words, and answers to Ctrl+K and
  the right-click menu as well; this row contributes a door, not a popover.
- **The one control that opens a menu opens `EditorMenu`.** Block alignment is
  a radio group inside the chrome wrapper, with the button as its `trigger`, so
  the kernel holds the open layer, one Escape spends one step on it, and the
  close hands the caret back to the prose. A raw Radix root here is a surface
  the Esc chain cannot see.

## Anti-patterns

- Reading enablement from `editor.can()` inside a component. The matrix is
  one function; call it.
- Classifying the selection by hand — `instanceof NodeSelection`, an ancestor
  walk for table cells, `isTextblock`. Every one of those has been wrong here:
  a selected table is a `CellSelection`, and a mermaid fence and a `jsx_leaf`
  are both text blocks.
- Adding a contextual control (language selector, table verbs, alt text) to
  this row.
- Rebuilding a surface another lane owns because the button is here.
- Opening a menu, popover, or dialog from a control on this row without the
  matching `chrome/` wrapper.
- Reviving `EditorLinkBubble` or any raise-on-click surface.

→ contracts, the full reason matrix, and the two readings behind it:
  [`.context/CONTEXT.md`](.context/CONTEXT.md)
→ [`../../AGENTS.md`](../../AGENTS.md)
→ design of record: `editor-toolbar-split/interaction-model.md` §2 laws,
  §10 rulings 14 to 17
