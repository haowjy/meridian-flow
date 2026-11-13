# Product words

Meridian Flow is a writing app for long fiction. A writer keeps a manuscript and notes in a
project, edits them in the browser, and works on them with a model in chat. The model reads
and writes the same documents, at the same time as the writer.

These are the product's words, briefly. The full vocabulary, with the rules behind each word,
is in the [knowledge base](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/vocab.md).

## People and containers

- **Writer.** The person using the app.
- **Project.** One book, serial or body of work. Documents, chats and Works belong to a project.
- **Work.** A task inside a project, such as "revise chapter 12". It groups the chats about the
  task, owns the drafts they produce and holds working notes called **Scratch**.
- **No Work.** The one Work every project is created with, for chats that belong to no named
  task. It is locked: it cannot be renamed, archived or deleted.

## Documents

- **Document.** One file of text, edited as a Yjs document so the writer's and the model's edits
  merge.
- **Context.** The project's files as the server and the model address them, like a file system
  with areas: `manuscript://`, `kb://` (reference notes, shown as Knowledge), `user://`,
  `scratch://` and `uploads://`.
- **Live.** A document's current shared text.
- **Draft.** A pending version of one document. The model writes into a draft, the writer
  reviews it as a diff against live, and nothing reaches live until the writer applies it.
- **Branch.** The set of drafts one owner holds. The owner is a Work, or, under No Work, one
  chat and the chats derived from it. Writers never see the word.
- **Apply, Discard, Undo.** **Apply** lands a draft's changes on live. **Discard** drops them.
  **Undo** reverses what one reply wrote, wherever that text now is.
- **Write mode.** A chat's setting for where the model's writes go: **Draft** (into a draft, for
  review) or **Auto-apply** (straight to live).
- **Receipt.** The card on a reply that lists the documents it edited and carries Undo.
- **Room.** The server's in-memory session for one Yjs document, which browsers join over a
  WebSocket. A **draft room** is the room for one draft.
- **Resource replica.** The browser's local copy of a project's documents and folders. A
  **catalog** is the server's listing of them, which the replica follows.
- **Import.** Bringing a folder or files into a project as one operation. The server prepares
  the result out of sight and then **reveals** it all at once.
- **Uploads.** Files a writer attaches in a chat or drops into a document.

## Chat

- **Chat, thread, conversation.** The same thing: "chat" or "conversation" on screen, "thread"
  in code.
- **Composer.** The message box.
- **Turn.** One entry in a thread: a writer message, one stretch of assistant output, or a note
  the system adds for the model.
- **Reply.** Everything the assistant produces for one writer request. It can span several
  turns.
- **Run.** One stretch of the server working on a thread, from claiming it to releasing it. Only
  one run works a thread at a time. Some pages call it an execution.
- **Agent.** The profile a chat runs with: a model, its tools, its instructions and whether it
  may edit.
- **Ask.** A question or a permission request from the model to the writer. The run ends while
  it waits, and the answer starts a new one.
- **Queue.** Messages sent while a reply is running wait in a queue. To **hand back** a queued
  message is to return its words to the composer.
- **Spawn, subagent.** A child thread that a run starts to do part of its work. It reports back
  to its parent.
- **Fork, handoff.** Two ways a writer makes a new chat from an existing one. A **fork** keeps
  the conversation up to a chosen point. A **handoff** starts fresh from a brief the model
  writes about the old chat.
- **Compaction.** Replacing a thread's older turns with a summary so the conversation still fits
  in the model's context window.
