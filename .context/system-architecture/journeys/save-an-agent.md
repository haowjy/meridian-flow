# Save an Agent

A writer changes an Agent in the project's `.agents` folder or their own `~/.agents`, saves the
package, and starts a chat that uses the saved version. The files are documents the writer and the
AI edit like any other; a chat uses a package only once it is saved.

## Edit the Agent's file

Does: opens an Agent's file in the Agents tab and types.

Sees: the file autosaves like any document. Beside the Agent's name a chip reads "Unsaved", and a note says whether the file is usable and why not, in Mars's words. New chats still use the version before.

- Map: [agents](../app-conversation.md#agents), [editor](../app-documents.md#editor), [packages](../server-conversation.md#packages)
- Machines: [Package Save word](../../../apps/app/src/features/agents/.context/state-machines.md)

## Save

Does: presses Save on the package's heading or on the open file, or Save all.

Sees: "Saved" at once, with Undo. An Agent or skill whose file has an error is not saved with that edit: its last saved version stays in use, or it is out if it never had one, and the error is listed with it ("Your latest edit isn't in use"). A broken `mars.toml` fails the Save and keeps the previous version.

- Map: [agents](../app-conversation.md#agents), [packages](../server-conversation.md#packages)
- Machines: [Package Save word](../../../apps/app/src/features/agents/.context/state-machines.md)

## Start a chat with it

Does: picks the Agent and sends a message.

Sees: the chat starts on the newest saved version of that Agent, even from a picker that was open before the Save. A chat already running keeps the version it started with.

- Map: [chat](../app-conversation.md#chat), [packages](../server-conversation.md#packages), [runtime](../server-conversation.md#runtime)
- Machines: [Chat submissions](../../../apps/app/src/client/chat-submissions/.context/state-machines.md)

## Undo the Save

Does: presses Undo beside "Saved", or on the AI's Save card.

Sees: new chats go back to the version before. Its text is merged into the files: an edit made since stays, where the writer changed the same text theirs stays, and no file is deleted. The package reads Unsaved if anything differs.

- Map: [agents](../app-conversation.md#agents), [packages](../server-conversation.md#packages), [collab](../server-documents.md#collab)
- Machines: [Package Save word](../../../apps/app/src/features/agents/.context/state-machines.md)
