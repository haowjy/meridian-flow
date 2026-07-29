# surfaces/toolbar — contracts

Reference depth for the document toolbar. Read [`AGENTS.md`](../AGENTS.md)
first.

## The enablement matrix

`documentToolbarControls` maps editor state plus a few host facts (editable,
history depth, upload availability) to one `{ active, blockedBy }` pair per
control. Reasons are codes; `toolbar-copy.ts` turns them into writer copy,
which is why the same code can read differently per control.

The contextual half of the table is keyed by the chrome kernel's resolved
owner — `resolveChromeContext(state).owner` plus its `nodeType` — not by the
selection. See [Two readings, owner first](#two-readings-owner-first).

| Context | Greyed controls | Reason code |
|---|---|---|
| Editor not mounted yet | all ten | `editor-loading` |
| Schema fence or read-only host | all ten | `document-read-only` |
| Owner `object`: a figure, image, rule, or a SELECTED table | heading, code block, bullet list, marks, link | `object-selection` |
| Owner `object` on a `code_block`: a rendered mermaid diagram | all of them, conversions included | `embedded-block` |
| Owner `source-block` on a `code_block`: a plain fence | heading, bullet list, marks, link (NOT code block, NOT turn-into-paragraph) | `code-block` |
| Owner `source-block` on anything else: a `jsx_leaf` | heading, code block, bullet list, marks, link | `embedded-block` |
| Owner `table-cell` | heading, code block, bullet list | `table-cell` |
| Owner `document`, every block in the span refusing alike | heading, code block, bullet list | that block's own code |
| Owner `document`, the span refusing unevenly (the Ctrl+A case) | heading, code block, bullet list | `mixed-selection` |
| Inline code covers the selection | bold, italic, link | `inline-code` |
| No paragraph, heading, or table under the selection | alignment | `no-alignable-block` |
| Yjs undo or redo stack empty | undo, redo | `empty-history` |
| Code-schema file | upload figure | `code-document` |
| Document opened without a project | upload figure | `no-project` |
| An upload already in flight | upload figure | `upload-in-flight` |

Read-only outranks every contextual reason: on a document the writer cannot
change, saying so once is the honest answer.

`active` is computed even while a control is greyed, so a read-only document
still shows what the block already is, and a rendered fence shows the Code
button lit and refused at once. A control whose state is already applied is
never blocked by a schema refusal either: what is on can always come off.

## Two readings, owner first

`blockTypeRefusal` asks two questions in order, and the order is the design.

1. **What is the selection standing inside?**
   `chromeContextRefusal(resolveChromeContext(state))` — the kernel's
   deepest-context read
   ([`core/editor/chrome`](../../../../../core/editor/chrome/.context/CONTEXT.md)),
   spoken as a reason. A writer inside something is owed that thing's reason: a
   caret in a diagram nested in a table cell is in the DIAGRAM, and the cell's
   reason there would name the wrong thing.
2. **Only if the document itself owns the context, what does the selection
   span?** Every text block the selection covers, each read through the same
   resolver at its own first inside position. ANY protected block refuses the
   whole conversion; the answer names a kind only when every block refuses as
   that same kind, and is `mixed-selection` otherwise — which covers both a
   part-convertible selection and one whose blocks all refuse but not alike.

Reading the selection directly instead is what the module used to do, and it
produced two wrong reasons: a whole selected table greyed as a table CELL
(prosemirror-tables spells "this table is selected" as a `CellSelection`, which
a local `instanceof NodeSelection` check cannot see), and a diagram inside a
cell greyed with the cell's reason.

Two node types read differently by owner, and the owner is what decides: a
`code_block` owning an `object` context is a rendered diagram (the kernel names
an object only what `isEditorObject` accepts), while one owning a
`source-block` context is a plain fence the writer types in.

**The resolver is called, not `chrome.context`.** The kernel caches the context
on the chrome instance, but the commands re-check this fence mid-chain and a
code-schema document mounts no chrome at all. The resolver is pure over
`EditorState`, so calling it is always current and always available.

**The span walk follows `selection.ranges`, not `from`..`to`.** A
`CellSelection` reports one of its cells as that pair while ProseMirror's own
commands run over every range, so reading the pair greyed Bold over a selection
whose other cells were pure prose — a control saying no to work it would have
done.

## Refusal predicates

The two command families fence differently, and the difference is the design:

- **Block type** (heading, code block, bullet list) rewrites whole blocks, so
  any protected target refuses the whole command, per the two readings above.
  Two commands share that fence with one exception: the code-block toggle and
  "turn into paragraph" are what a PLAIN fence REVERSES, so `code-block` alone
  is not a refusal for either. A mixed selection still is, because fencing the
  prose around a fence rewrites the fence's attributes with it — and a rendered
  object fence is not reversible at all (its reason is `embedded-block`),
  because un-fencing a diagram is the same loss as converting one to a heading.
- **Marks** (bold, italic, code, link) land per node, so they refuse only when
  NOTHING in the selection can take them. **A table cell is prose** (§5.4),
  which is the one place marks part ways with the block fence: a cell refuses to
  become a heading and takes bold in the same breath, and it matters most for a
  selected table, whose cells hold every word in it. Past that, availability
  comes from `editor.can().setMark` — the command's own answer, schema
  allowance and mark exclusions in one call, so the matrix cannot advertise what
  dispatch refuses. The one exclusion in this schema is the inline code mark,
  which excludes every other mark from the text it covers.

`blockTypeStates` is that matrix for the eight types "Turn into" offers, and
`turnIntoBlockType` is the command behind them: a true toggle, so choosing the
checked type returns the block to a paragraph (law 6). `textMarkState` is the
same pair for one mark. Both exist because the formatting menu and the block
menu carry these verbs and must refuse exactly what this fence refuses.

Alignment has no fence: it writes to every alignable block the selection
touches, so a select-all centers the chapter rather than greying. A caret in a
table cell aligns the TABLE, because `alignableBlocksInSelection` stops its walk
at the table (per-column alignment belongs to the table grips, §5.4).

`blockTypeRefusal` and `codeBlockRefusal` are exported, and
`BlockTypeRefusalReason` names their answers. Every other surface that rewrites
a whole block — the block menu's Turn into — calls them rather than re-deriving
the rule, so a new protected node type is one edit here instead of one per
surface. `blockTypeReasonMessage` is the matching copy.

## The reason copy

`blockedReasonMessage(subject, reason)` branches on the subject's family, not
on the individual control: block type, link, or plain formatting. A surface
whose controls are not toolbar rows passes the family (`"block-type"`,
`"mark"`) or `"document"` where only the document's own reasons can reach it.
One reason, one wording, wherever the writer meets it.

`mixed-selection` and `table-cell` only ever reach a block-type control: a cell
is prose, and a mark lands on the prose in a mixed selection rather than
refusing it.

## The Link button

The button is a door into the link lane's form (`core/editor/links` plus
[`../link/AGENTS.md`](../../link/AGENTS.md)), which also answers Ctrl+K, the
formatting menu's Add link, and the right-click menu. `active` and the blocked
reason still come from this module's matrix, because the row's lit-or-greyed
language is one answer for all ten controls; everything the form does — draft
resolution, range mapping, commit, removal — belongs to the link lane, and
nothing about it is decided here.

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
