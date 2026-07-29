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
| Every target is a code block | heading, bullet list, marks, link (NOT code block, NOT turn-into-paragraph) | `code-block` |
| Every target is a rendered object fence (a mermaid diagram) | all of them, conversions included | `embedded-block` |
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
  mermaid fence and a component conversion drop its name and props. Two commands
  share that fence with one exception: the code-block toggle and "turn into
  paragraph" are what a PLAIN fence REVERSES, so `code-block` alone is not a
  refusal for either. A mixed selection still is, because fencing the prose
  around a fence rewrites the fence's attributes with it — and a rendered
  object fence is not reversible at all (its reason is `embedded-block`),
  because un-fencing a diagram is the same loss as converting one to a
  heading.
- **Marks** (bold, italic, code, link) land per node, so they refuse only when
  NOTHING in the selection can take them. Availability comes from
  `editor.can().setMark`, which is the command's own answer: schema allowance
  and mark exclusions in one call, so the matrix cannot advertise what dispatch
  refuses. The one exclusion in this schema is the inline code mark, which
  excludes every other mark from the text it covers.

`blockTypeStates` is that matrix for the eight types "Turn into" offers, and
`turnIntoBlockType` is the command behind them: a true toggle, so choosing the
checked type returns the block to a paragraph (law 6). `textMarkState` is the
same pair for one mark. Both exist because the formatting menu and the block
menu carry these verbs and must refuse exactly what this fence refuses.

Alignment has no fence: it writes to every alignable block the selection
touches, so a select-all centers the chapter rather than greying.

`blockTypeRefusal` and `codeBlockRefusal` are exported, and `BlockTypeRefusalReason`
names their answers. Every other surface that rewrites a whole block — the block
menu's Turn into — calls them rather than re-deriving the rule, so a new protected
node type is one edit here instead of one per surface. `blockTypeReasonMessage`
is the matching copy.
## The reason copy
`blockedReasonMessage(subject, reason)` branches on the subject's family, not
on the individual control: block type, link, or plain formatting. A surface
whose controls are not toolbar rows passes the family (`"block-type"`,
`"mark"`) or `"document"` where only the document's own reasons can reach it.
One reason, one wording, wherever the writer meets it.

## Link popover

`useLinkDraft` is the whole lifecycle — resolve on open, follow the document,
read at commit — and it is exported because the formatting menu opens the same
form at a pointer instead of under a button. `resolveLinkDraft` reads the
selection when the popover opens, not when it commits: focus moves into the form, and the commit must rewrite the range the
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

## Closing a surface returns the caret

Both surfaces this module opens — the link popover and the alignment menu —
override Radix's `onCloseAutoFocus`, prevent its default, and focus the editor.
Radix restores focus to the trigger, which is right for a page and wrong for a
manuscript: the writer never left the sentence, so the next Space must be a
space rather than a control being re-activated. Any surface added here owes the
same handler on every close path, selection and dismissal alike.

## Why greying, not disabling

`disabled` removes the button from the hover and focus path, so its tooltip
never opens and the writer never learns the reason — which is the dead control
law 5 forbids. Blocked controls carry `aria-disabled`, keep pointer events,
drop their `onClick`, and dim to the same opacity the disabled style uses.
