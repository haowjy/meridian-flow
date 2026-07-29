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
| Every target is a code block | heading, bullet list, marks, link | `code-block` |
| Every target is a registered component (`jsx_leaf`) | heading, bullet list, marks, link | `embedded-block` |
| Every target sits in a table cell | heading, bullet list | `table-cell` |
| Some but not all targets are protected (the Ctrl+A case) | heading, bullet list | `mixed-selection` |
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

- **Block type** (heading, bullet list) rewrites whole blocks, so ANY
  protected target in the selection refuses the whole command. Protected means
  a node selection on a non-textblock, a node the schema marks as `code`
  (a fence or a `jsx_leaf`, both text blocks by ProseMirror's reckoning), or a
  paragraph inside a table cell, which holds exactly one paragraph and can be
  nothing else. Classifying by `isTextblock` is what let a select-all flatten a
  mermaid fence and a component conversion drop its name and props.
- **Marks** (bold, italic, code, link) land per node, so they refuse only when
  NOTHING in the selection can take them. Availability comes from
  `editor.can().setMark`, which is the command's own answer: schema allowance
  and mark exclusions in one call, so the matrix cannot advertise what dispatch
  refuses. The one exclusion in this schema is the inline code mark, which
  excludes every other mark from the text it covers.

Alignment has no fence: it writes to every alignable block the selection
touches, so a select-all centers the chapter rather than greying.

## Link popover

`resolveLinkDraft` reads the selection when the popover opens, not when it
commits: focus moves into the form, and the commit must rewrite the range the
writer was looking at. A bare caret produces `needsText`, which is the only
thing that decides between the one-field and two-field forms.

The range travels: an open popover outlives the positions it opened with (a
peer types above the selection, an AI write lands), so `mapLinkDraft` follows
every transaction and the commit rewrites the words the writer chose.

`commitLinkDraft` returns `applied`, `removed`, `invalid`, or `refused` — the
command's real result, never an assumption. The form stays open on `invalid`
so a bad URL never closes over a change that did not happen, and `refused`
covers a document that turned read-only while the form was open. Rewriting a
link's text keeps the marks that text already wore.

## Why greying, not disabling

`disabled` removes the button from the hover and focus path, so its tooltip
never opens and the writer never learns the reason — which is the dead control
law 5 forbids. Blocked controls carry `aria-disabled`, keep pointer events,
drop their `onClick`, and dim to the same opacity the disabled style uses.
