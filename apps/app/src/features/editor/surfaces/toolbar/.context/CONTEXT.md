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
| Node selection on a non-textblock (figure, image, rule, table) | heading, bullet list, bold, italic, code, link | `object-selection` |
| Same selection | alignment | `no-alignable-block` |
| Selection entirely inside a code block | heading, bullet list | `code-block` |
| Caret or selection in a code block | bold, italic, code, link, alignment | `code-block`, alignment `no-alignable-block` |
| No paragraph, heading, or table under the selection | alignment | `no-alignable-block` |
| Yjs undo or redo stack empty | undo, redo | `empty-history` |
| Document opened without a project | upload figure | `no-project` |
| An upload already in flight | upload figure | `upload-in-flight` |

Read-only outranks every contextual reason: on a document the writer cannot
change, saying so once is the honest answer.

`active` is computed even while a control is greyed, so a read-only document
still shows what the block already is.

## Refusal predicates

Two predicates produce every contextual reason, and the commands re-run them:

- `objectSelectionBlocker` — a `NodeSelection` on a node that is not a text
  block. Formatting has no text to land on and a block-type conversion would
  destroy the node (the F6 accident).
- `marksApplyTo` — a port of prosemirror-commands' internal `markApplies`. It
  is the schema's own answer, so the reason survives new markless blocks;
  `code_block` is the only one today, which is why the code maps a schema
  refusal to `code-block`.

Enablement is derived from editor state rather than `editor.can()` so the
matrix is one testable function rather than ten call sites.

## Link popover

`resolveLinkDraft` reads the selection when the popover opens, not when it
commits: focus moves into the form, and the commit must rewrite the range the
writer was looking at. A bare caret produces `needsText`, which is the only
thing that decides between the one-field and two-field forms.

`commitLinkDraft` returns `applied`, `removed`, `invalid`, or `refused`. The
form stays open on `invalid` so a bad URL never closes over a change that did
not happen, and `refused` covers a document that turned read-only while the
form was open.

## Why greying, not disabling

`disabled` removes the button from the hover and focus path, so its tooltip
never opens and the writer never learns the reason — which is the dead control
law 5 forbids. Blocked controls carry `aria-disabled`, keep pointer events,
drop their `onClick`, and dim to the same opacity the disabled style uses.
