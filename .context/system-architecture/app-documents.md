# App: documents

The editing screens. A document opens from the workspace in main's tab row, or beside a chat (1); the editor binds a document session from the core (2); the core connects the Yjs socket to the server (3) and the server's updates, the writer's and the model's, come back through it (4). A Work's draft is suggestion marks in that same Live document: `draft-review` reads its Changes from the editor's session (5). Back to the [app](app.md).

```mermaid
flowchart LR
  editor["editor<br/><small>the editor and its toolbar</small>"]:::feature
  draft-review["draft-review<br/><small>Changes, Apply, Discard, Undo</small>"]:::feature
  links["links<br/><small>following an internal link</small>"]:::feature
  project["project<br/><small>the workspace shell</small>"]:::context
  core["core<br/><small>document sessions and the socket</small>"]:::context
  shared["shared<br/><small>UI and rich text</small>"]:::context
  conversation["conversation<br/><small>chat</small>"]:::context
  server["server<br/><small>the Yjs socket</small>"]:::context
  project -->|"1. opens a document in main or beside a chat"| editor
  editor -->|"2. binds the document session"| core
  core -->|"3. connects the Yjs socket"| server
  server -->|"4. sends the document's updates"| core
  draft-review -->|"5. reads the Work's suggestions from the session"| core
  editor -->|"shows review controls from"| draft-review
  editor -->|"follows links with"| links
  conversation -->|"shows Drafted-documents cards from"| draft-review
  editor -->|"renders with"| shared
  note1["draft-review is where the model's edits become something the writer decides on: the Work's suggestions as Changes, then Apply, Discard or Undo."]:::note
  note1 -.- draft-review
```

## editor

Editor chrome and its surfaces over `core/editor`.

Binds the document session, chooses live or review presentation and mounts the toolbar, identity bar and sync pill.

- Kind: feature
- Paths: `apps/app/src/features/editor`
- Docs: [CONTEXT](../../apps/app/src/features/editor/.context/CONTEXT.md), [AGENTS](../../apps/app/src/features/editor/AGENTS.md)
- Machines: [editor](../../apps/app/src/features/editor/.context/state-machines.md)

## draft-review

Review of a Work's draft: Changes, Apply, Discard, Undo.

A change is a run of the Work's suggestion marks in the Live document, read from the host's
editor (`suggestion-review`). Apply or Discard of one change is an editor transaction; of a
document, folder or Work it is a press on the server.

- Kind: feature
- Paths: `apps/app/src/features/draft-review`, `apps/app/src/features/suggestion-review`
- Docs: [AGENTS](../../apps/app/src/features/draft-review/AGENTS.md), [suggestion review](../../apps/app/src/features/suggestion-review/.context/CONTEXT.md)
- Machines: [draft-review](../../apps/app/src/features/draft-review/.context/state-machines.md)

## links

Following an internal link.

Resolves links from the local project index first, then the server; a failed request keeps the local answer. A link still opens after its target is moved or renamed.

- Kind: feature
- Paths: `apps/app/src/features/links`
- Docs: [CONTEXT](../../apps/app/src/features/links/.context/CONTEXT.md), [AGENTS](../../apps/app/src/features/links/AGENTS.md)

## project

The workspace shell.

Main and side panes, sidebar, tabs, Works and routing.

- Kind: context
- See: [project](app.md#project)

## core

The editor core.

The group of the editor session, transport, tree list, uploads and completion.

- Kind: context
- See: [core](app.md#core)

## shared

Shared UI and helpers.

The group of `components`, `hooks`, `lib` and `rich-content`.

- Kind: context
- See: [shared](app.md#shared)

## conversation

Chat and Agents.

The group of `chat` and `agents`.

- Kind: context
- See: [conversation](app.md#conversation)

## server

The server.

HTTP, the thread socket and the Yjs socket.

- Kind: context
- See: [server](system.md#server)
