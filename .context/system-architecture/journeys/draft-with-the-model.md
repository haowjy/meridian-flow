# Draft with the model

A writer asks the model for a chapter, watches it work, then reviews what it drafted and applies it
or throws it away. In Draft mode the model's writes land in the chat's draft: its tree changes (new
documents, renames, moves, deletes) and, per document, a fork room of the text, which the writer
opens and edits as the draft and a press applies to Live or discards.

## Pick the Work

Does: chooses a Work, the task this session belongs to, from the picker under the project name. "None" is the row for no Work.

Sees: the picker keeps the choice, which decides which chats and drafts the sidebar shows. A new chat's composer has its own Work control; if that Work becomes unavailable the composer says "Selected Work unavailable."

- Map: [project](../app.md#project), [projects](../server-workspace.md#projects)
- Machines: [Work archive and delete](../../../apps/server/server/domains/projects/.context/state-machines.md)

## Open a chapter in Write mode

Does: opens a chapter from the project and switches to Write mode.

Sees: the chapter in a tab in the main area, and beside it the side pane with the last chat the writer had on screen, or a new chat about the chapter. Main and the side never hold the same kind: the Write | Chat switch swaps them.

- Map: [project](../app.md#project), [editor](../app-documents.md#editor), [core-editor](../app-core.md#core-editor), [Opening a document](../flows/opening-a-document.md)
- Machines: [Document session status](../../../apps/app/src/core/editor/.context/state-machines.md)

## Ask for an edit

Does: types the request in the message box and sends it. A chip beside the box reads "Draft" or "Auto-apply" (what the model's writes do); the Agent picker sits beside it.

Sees: the chat opens at once with the message. The send does not wait for the server, and a failure shows on the chat.

- Map: [browser](../system.md#browser), [chat](../app-conversation.md#chat), [client](../app.md#client), [runtime](../server-conversation.md#runtime), [A message becomes an edit](../flows/message-becomes-edit.md)
- Machines: [Chat submissions](../../../apps/app/src/client/chat-submissions/.context/state-machines.md), [User-turn admission](../../../apps/server/server/domains/runtime/.context/state-machines.md)

## Watch the reply

Does: reads the reply as it streams.

Sees: tool and helper (subagent) cards appear where the turn started them. A reply that only wrote drafts ends with "Drafted 1 document" (or "Drafted N documents"). Stop in the message box ends the reply; the message above a stopped reply then has Edit, which puts its words and chips back in the box, above anything typed there, to fix and send again.

- Map: [server](../system.md#server), [threads](../server-conversation.md#threads), [runtime](../server-conversation.md#runtime), [thread-client](../code.md#thread-client)
- Machines: [Turn status](../../../apps/server/server/domains/runtime/.context/state-machines.md), [Thread socket](../../../packages/thread-client/.context/state-machines.md)

## Find the changes

Does: opens the Changes tab in the sidebar, which appears in the strip while there are drafts to review.

Sees: the Work's drafted documents with a pending count, and "Apply all" and "Discard all", with the same two on each row. A folder the Work changes heads the documents under it ("New", "Was Arc 2", "Moving into Book One"), with × and ✓ for all of them; a new document's row says where it lands ("New in Manuscript/Arc 3"); a change that cannot land says why in a red line, and still does after Apply. Under None it lists the drafts of the open chat only. When the picked Work has nothing to review and another Work does, the empty list names that Work and its count, and picking it switches the sidebar to it.

- Map: [draft-review](../app-documents.md#draft-review), [collab](../server-documents.md#collab)
- Machines: [Draft review](../../../apps/app/src/features/draft-review/.context/state-machines.md)

## See the Work's tree

Does: picks the Work's draft in the sidebar's version chip beside Changes, which reads "Live" (offered while the Work has pending changes).

Sees: every sidebar source turns to the Work's tree on a grey review ground, at once (the browser replays it from its copy of the list), and the open page switches to its draft if it has one. A click opens a document on its draft; a rename, move or new document goes into the Work's draft. The chip now reads "Draft"; picking Live in it brings back live, and the page with it. On Live, a jade dot marks each row the Work changes, and a page the Work drafts opens live with its chip neutral and a jade dot; the chip's menu lists the draft. Picking a version in the chip, or opening a change from Changes, moves the toggle with it. Ctrl+Z in the sidebar takes back the writer's latest tree change in the source on screen, made in the view on screen; a change someone has changed since is skipped with a notice.

- Map: [draft-review](../app-documents.md#draft-review), [collab](../server-documents.md#collab)
- Machines: [Draft review](../../../apps/app/src/features/draft-review/.context/state-machines.md)

- Map: [project](../app.md#project), [core-tree-list](../app-core.md#core-tree-list)
- Machines: [Sidebar version](../../../apps/app/src/features/project/.context/tree-version-state-machine.md)

## Review a draft in the document

Does: opens a drafted document, then presses "Review N changes" beside the Draft chip, or clicks its row in Changes.

Sees: the plain draft first, typing as on Live. Review changes puts Live's text of each changed paragraph above the draft's, in muted ink, with × and ✓ in the margin beside it (Side by side puts Live in a column of its own). A line above the toolbar says what the draft is compared against and holds the stepper ("3 of 12", counted over the whole draft, chapter to chapter), the chapter's × and ✓, and Close. Every changed block is a stop, a rule or an image too; a change that left the text alone says "Moved" or "Style" in place of the old text. A change's × or ✓ takes it at once and the next change takes the focus; Ctrl+Z takes it back. Back, Close or Esc leave Review changes; the address keeps it, so a reload or a shared link opens the same change.

- Map: [editor](../app-documents.md#editor), [draft-review](../app-documents.md#draft-review), [file-policy](../server-documents.md#file-policy)
- Machines: [Document session status](../../../apps/app/src/core/editor/.context/state-machines.md)

## Apply or discard

Does: presses Apply (the filled green button) or Discard (quiet text).

Sees: after Apply, the Work's tree changes (a move, a rename, a new document) and its text changes are live. Apply or Discard takes one change, a document, a draft, or every draft of the Work. After Discard, they are gone and the project reads as it did; Discard does not ask first, and a notice reads "Draft of … discarded." with Undo. Only a document or folder the Work created goes to Trash, where Restore brings it back into the project. The notice's Undo, the sidebar's Undo step or Ctrl+Z in the document takes an Apply or a Discard back while the tab is open, and puts the writer back where they were before it: a created document or folder is pending in the review again, out of Live and out of Trash. Trash's Restore brings a discarded created document into Live instead; after it, that Undo has nothing left to do.

- Map: [draft-review](../app-documents.md#draft-review), [collab](../server-documents.md#collab), [agent-edit](../code.md#agent-edit)
- Machines: [An Apply's Undo](../../../apps/app/src/features/draft-review/.context/state-machines.md)

## Undo

Does: presses Undo on the reply's receipt, the card that lists every document the reply wrote. There is no Redo: to get it back, ask the model to write it again.

Sees: what the reply wrote is reversed, wherever it now is. The receipt stays.

## Undo turn

Does: on a Draft chat's reply, presses "Undo turn" on its receipt (one per draft the reply wrote in, in place of the receipt's Undo, which keeps only what the reply did in Live), or opens one of its chapters there.

Sees: a chapter opens in Review changes at the reply's edit. Undo turn takes back what the reply did in the draft, by the one Undo rule: its text, and its renames, moves and deletes still waiting there; what the writer already applied stays in the manuscript, and a document the reply made in the draft goes to Trash. The button shows while the reply has something there to take back. The receipt then reads "Undone" with an Undo, in every tab and after a reload, and says nothing about what stayed; Ctrl+Z in the chapter or in the sidebar takes it back too, as for any press.

- Map: [chat](../app-conversation.md#chat), [draft-review](../app-documents.md#draft-review), [collab](../server-documents.md#collab)
- Machines: [A press's Undo](../../../apps/app/src/features/draft-review/.context/state-machines.md)

- Map: [chat](../app-conversation.md#chat), [collab](../server-documents.md#collab), [agent-edit](../code.md#agent-edit)
