# surfaces/toolbar — contracts

Reference depth for the document toolbar. Read [`AGENTS.md`](../AGENTS.md)
first.

## The enablement matrix

`documentToolbarControls` maps editor state plus a few host facts (editable,
history depth, upload availability) to one `{ active, blockedBy }` pair per
control. Reasons are codes; `toolbar-copy.ts` turns them into writer copy,
which is why the same code can read differently per control.

| Context | Greyed controls | Reason code |
|---|---|---|
| Editor not mounted yet | all ten | `editor-loading` |
| Schema fence or read-only host | all ten | `document-read-only` |
| Node selection on a non-textblock (figure, image, rule, table) | heading, bullet list, marks, link | `object-selection` |
| Same selection | alignment | `no-alignable-block` |
| Every target is a code block | heading, bullet list, marks, link (NOT code block) | `code-block` |
| Every target is a registered component (`jsx_leaf`) | heading, code block, bullet list, marks, link | `embedded-block` |
| Every target sits in a table cell | heading, code block, bullet list | `table-cell` |
| Some but not all targets are protected (the Ctrl+A case) | heading, code block, bullet list | `mixed-selection` |
| Inline code covers the selection | bold, italic, link | `inline-code` |
| No paragraph, heading, or table under the selection | alignment | `no-alignable-block` |
| Yjs undo or redo stack empty | undo, redo | `empty-history` |
| Code-schema file | upload figure | `code-document` |
| Document opened without a project | upload figure | `no-project` |
| An upload already in flight | upload figure | `upload-in-flight` |

Read-only outranks every contextual reason: on a document the writer cannot
change, saying so once is the honest answer.

`active` is computed even while a control is greyed, so a read-only document
still shows what the block already is. A control whose state is already applied
is never blocked by a schema refusal either: what is on can always come off.

## Refusal predicates

The two command families fence differently, and the difference is the design:

- **Block type** (heading, code block, bullet list) rewrites whole blocks, so ANY
  protected target in the selection refuses the whole command. Protected means
  a node selection on a non-textblock, a node the schema marks as `code`
  (a fence or a `jsx_leaf`, both text blocks by ProseMirror's reckoning), or a
  paragraph inside a table cell, which holds exactly one paragraph and can be
  nothing else. Classifying by `isTextblock` is what let a select-all flatten a
  mermaid fence and a component conversion drop its name and props. The code
  block control shares that fence with one exception: a code block is what it
  REVERSES, so `code-block` alone is not a refusal for it. A mixed selection
  still is, because fencing the prose around a fence rewrites the fence's
  attributes with it.
- **Marks** (bold, italic, code, link) land per node, so they refuse only when
  NOTHING in the selection can take them. Availability comes from
  `editor.can().setMark`, which is the command's own answer: schema allowance
  and mark exclusions in one call, so the matrix cannot advertise what dispatch
  refuses. The one exclusion in this schema is the inline code mark, which
  excludes every other mark from the text it covers.

Alignment has no fence: it writes to every alignable block the selection
touches, so a select-all centers the chapter rather than greying.

## The Link button

The button is a door into the link lane's form (`core/editor/links` plus
`features/editor/surfaces/link`), which also answers Ctrl+K and the right-click
menu. `active` still comes from this module's matrix, because the row's
lit-or-greyed language is one answer for all ten controls; everything the form
does — draft resolution, range mapping, commit, removal — belongs to the link
lane, and nothing about it is decided here.

## Closing a surface returns the caret

The one surface this module opens — the alignment menu — overrides Radix's
`onCloseAutoFocus`, prevents its default, and focuses the editor.
Radix restores focus to the trigger, which is right for a page and wrong for a
manuscript: the writer never left the sentence, so the next Space must be a
space rather than a control being re-activated. Any surface added here owes the
same handler on every close path, selection and dismissal alike.

## Why greying, not disabling

`disabled` removes the button from the hover and focus path, so its tooltip
never opens and the writer never learns the reason — which is the dead control
law 5 forbids. Blocked controls carry `aria-disabled`, keep pointer events,
drop their `onClick`, and dim to the same opacity the disabled style uses.
