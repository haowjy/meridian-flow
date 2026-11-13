# Draft with the model

A writer asks the model for a chapter, watches it work, then reviews what it drafted and applies it
or throws it away. The chat is in Draft mode: the model writes into a draft, a pending version of
the document, and nothing reaches the live document until the writer applies it. In Auto-apply
mode the writes go straight to live. Either way the writer can undo them.

## Pick the Work

Does: chooses a Work, the task this session belongs to, from the picker under the project name. "None" is the row for no Work.

Sees: the picker keeps the choice, which decides which chats and drafts are shown; if it becomes unavailable the app says "Your selected Work is unavailable. Choose another Work, or None."

- Map: [project](../app.md#project), [projects](../server.md#projects)
- Machines: [Work archive and delete](../../../apps/server/server/domains/projects/.context/state-machines.md)

## Open a chapter in Write mode

Does: opens a chapter from the project and switches to Write mode.

Sees: the chapter in a tab in the main area, and a side view with the current chat or a new chat beside it.

- Map: [project](../app.md#project), [editor](../app.md#editor), [core-editor](../app.md#core-editor)
- Machines: [Document session status](../../../apps/app/src/core/editor/.context/state-machines.md)

## Ask for an edit

Does: types the request in the message box and sends it. A chip beside the box reads "Draft" or "Auto-apply" (what the model's writes do); the Agent picker sits beside it.

Sees: the chat opens at once with the message. The send does not wait for the server, and a failure shows on the chat.

- Map: [browser](../system.md#browser), [chat](../app.md#chat), [client](../app.md#client), [runtime](../server.md#runtime)
- Machines: [Chat submissions](../../../apps/app/src/client/chat-submissions/.context/state-machines.md), [User-turn admission](../../../apps/server/server/domains/runtime/.context/state-machines.md)

## Watch the reply

Does: reads the reply as it streams.

Sees: tool and helper (subagent) cards appear where the turn started them. A reply that only wrote drafts ends with "Drafted 1 document" (or "Drafted N documents").

- Map: [server](../system.md#server), [threads](../server.md#threads), [runtime](../server.md#runtime), [thread-client](../code.md#thread-client)
- Machines: [Turn status](../../../apps/server/server/domains/runtime/.context/state-machines.md), [Thread socket](../../../packages/thread-client/.context/state-machines.md), [Response](../../../packages/agent-edit/.context/state-machines.md)

## Find the changes

Does: opens the Changes tab in the sidebar.

Sees: the Work's drafted documents with a pending count, and "Apply all" and "Discard all", with the same two on each row. Under None it lists the drafts of the open chat only.

- Map: [draft-review](../app.md#draft-review), [collab](../server.md#collab)
- Machines: [Draft and branch](../../../apps/server/server/domains/collab/.context/state-machines.md), [Draft review](../../../apps/app/src/features/draft-review/.context/state-machines.md)

## Review a draft in the document

Does: opens a drafted document.

Sees: a Draft chip in the toolbar and a line of review controls above the page. "Show changes" turns the diff on and off, and the Live menu lists every draft of the page.

- Map: [editor](../app.md#editor), [draft-review](../app.md#draft-review), [file-policy](../server.md#file-policy)
- Machines: [Draft room read](../../../apps/app/src/core/editor/.context/state-machines.md)

## Apply or discard

Does: presses Apply (the filled green button) or Discard (quiet text).

Sees: after Apply, the live page has the model's text. After Discard, the draft is gone and the live page is unchanged; discarding a text draft does not ask first, and a notice reads "Draft of … discarded." with Undo.

- Map: [draft-review](../app.md#draft-review), [collab](../server.md#collab), [agent-edit](../code.md#agent-edit)
- Machines: [Apply click command](../../../apps/app/src/features/draft-review/.context/state-machines.md), [Branch command](../../../apps/server/server/domains/collab/.context/state-machines.md)

## Undo

Does: presses Undo on the reply's receipt, the card that lists every document the reply wrote. Redo puts it back.

Sees: what the reply wrote is reversed, wherever it now is. The receipt stays.

- Map: [chat](../app.md#chat), [collab](../server.md#collab), [agent-edit](../code.md#agent-edit)
- Machines: [Draft write journal row](../../../apps/server/server/domains/collab/.context/state-machines.md)
