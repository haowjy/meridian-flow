# Draft with the model

A writer asks the model for a chapter, watches it work, then reviews what it drafted and applies it
or throws it away. This journey follows a chat in Draft mode, where the model writes into a draft,
a pending version of the document, and nothing reaches the live document until the writer applies
it. In Auto-apply mode the model's writes go straight to live. Either way the writer can undo them.

The screens are those of the interface redesign in pull request #1304, which is not merged yet.
In a Source line, **code** means the message catalog or code on that branch, and **the redesign's
description** means the pull request's text, which was not checked against the code.

## Pick the Work

Does: chooses a Work, the task this session belongs to, from the picker under the project name. "None" is the row for no Work.

Sees: the picker keeps the choice. A Work groups its chats and owns the drafts they produce, so the choice decides which chats and drafts are shown; if it becomes unavailable the app says "Your selected Work is unavailable. Choose another Work, or None."

Source: code for the "None" row, the unavailable message and "Manage Works…"; the redesign's description for the picker's place under the project name.

- Map: [project](../app.md#project), [projects](../server.md#projects)
- Machines: [Work archive and delete](../../../apps/server/server/domains/projects/.context/state-machines.md)

## Open a chapter in Write mode

Does: opens a chapter from the project and switches to Write mode.

Sees: the chapter in a tab in the main area, and a side view with the current chat or a new chat beside it.

Source: code for the "Write" and "New chat" strings; the redesign's description for the side-view layout.

- Map: [project](../app.md#project), [editor](../app.md#editor), [core-editor](../app.md#core-editor)
- Machines: [Document session status](../../../apps/app/src/core/editor/.context/state-machines.md)

## Ask for an edit

Does: types the request in the message box and sends it. A chip beside the box reads "Draft" or "Auto-apply" (what the model's writes do); the Agent picker sits beside it.

Sees: the chat opens at once with the message in a grey well. The send does not wait for the server: the first send is journaled in the browser before the app navigates, and a failure shows on the chat, not on a screen the writer already left.

Source: code for the journal, the chip strings and the optimistic send; the redesign's description for the grey well.

- Map: [browser](../system.md#browser), [chat](../app.md#chat), [client](../app.md#client), [runtime](../server.md#runtime)
- Machines: [Chat submissions](../../../apps/app/src/client/chat-submissions/.context/state-machines.md), [User-turn admission](../../../apps/server/server/domains/runtime/.context/state-machines.md)

## Watch the reply

Does: reads the reply as it streams.

Sees: tool and helper (subagent) cards appear where the turn started them. A reply that only wrote drafts ends with "Drafted 1 document" (or "Drafted N documents").

Source: code for the "Drafted" strings; the redesign's description for the helper cards' placement.

- Map: [server](../system.md#server), [threads](../server.md#threads), [runtime](../server.md#runtime), [thread-client](../code.md#thread-client)
- Machines: [Turn status](../../../apps/server/server/domains/runtime/.context/state-machines.md), [Thread socket](../../../packages/thread-client/.context/state-machines.md), [Response](../../../packages/agent-edit/.context/state-machines.md)

## Find the changes

Does: opens the Changes tab in the sidebar.

Sees: the Work's drafted documents with a pending count, and "Apply all" and "Discard all", with the same two on each row. Under None it lists the drafts of the open chat only.

Source: code for "Changes", "Apply all" and "Discard all"; the redesign's description for the None behaviour.

- Map: [draft-review](../app.md#draft-review), [collab](../server.md#collab)
- Machines: [Draft and branch](../../../apps/server/server/domains/collab/.context/state-machines.md), [Draft review](../../../apps/app/src/features/draft-review/.context/state-machines.md)

## Review a draft in the document

Does: opens a drafted document.

Sees: a Draft chip in the toolbar and a line of review controls above the page. "Show changes" turns the diff on and off, and the Live menu lists every draft of the page.

Source: code for "Draft", "Show changes" and "Live"; the redesign's description for where the controls sit.

- Map: [editor](../app.md#editor), [draft-review](../app.md#draft-review), [file-policy](../server.md#file-policy)
- Machines: [Draft room read](../../../apps/app/src/core/editor/.context/state-machines.md)

## Apply or discard

Does: presses Apply (the filled green button) or Discard (quiet text).

Sees: after Apply, the live page has the model's text. After Discard, the draft is gone and the live page is unchanged; discarding a text draft does not ask first, and a notice reads "Draft of … discarded." with Undo.

Source: code for the notice string; the redesign's description for the missing confirmation and the button styles.

- Map: [draft-review](../app.md#draft-review), [collab](../server.md#collab), [agent-edit](../code.md#agent-edit)
- Machines: [Apply click command](../../../apps/app/src/features/draft-review/.context/state-machines.md), [Branch command](../../../apps/server/server/domains/collab/.context/state-machines.md)

## Undo

Does: presses Undo on the reply's receipt (and Redo to put it back). The receipt lists every document the reply wrote, in a draft or live, and is there as soon as the reply finishes: Apply and Discard do not create or change it.

Sees: what the reply wrote is reversed, wherever it now is. The receipt stays, so the writer can always see what the reply changed.

Source: code for the "Undo" and "Redo" strings; what the receipt records is from `apps/app/src/features/chat/.context/turn-edit-receipts.md`; the redesign's description for where the receipt sits.

- Map: [chat](../app.md#chat), [collab](../server.md#collab), [agent-edit](../code.md#agent-edit)
- Machines: [Draft write journal row](../../../apps/server/server/domains/collab/.context/state-machines.md)
