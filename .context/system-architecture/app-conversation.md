# App: conversation

Chat on the screen. The composer sends the message through the client (1), which posts it (2); the server streams the events back (3) and the transcript draws them from the thread store (4). The Agent picker records which saved Agent and revision a new chat uses; the Agents tab and an open Agent file show what Mars made of each file and save each package. Back to the [app](app.md).

```mermaid
flowchart LR
  chat["chat<br/><small>the transcript and the composer</small>"]:::feature
  agents["agents<br/><small>the Agent picker, file verdicts and Save</small>"]:::feature
  project["project<br/><small>the workspace shell</small>"]:::context
  client["client<br/><small>HTTP clients and the thread store</small>"]:::context
  shared["shared<br/><small>UI and rich text</small>"]:::context
  documents["documents<br/><small>draft review cards</small>"]:::context
  server["server<br/><small>HTTP and sockets</small>"]:::context
  chat -->|"1. sends the message"| client
  client -->|"2. posts it to the server"| server
  server -->|"3. streams the events"| client
  chat -->|"4. draws the transcript from the thread store"| client
  chat -->|"picks the Agent and shows the AI's Saves with"| agents
  project -->|"shows the chat beside the document"| chat
  project -->|"shows Agent files' verdicts and Save with"| agents
  chat -->|"renders Markdown with"| shared
  chat -->|"shows Drafted-documents cards from"| documents
```

## chat

The transcript and the composer.

The transcript is drawn from the same view model `./mf` prints. The composer, its toolbar and its Work and write-mode controls are in `composer/`.

- Kind: feature
- Paths: `apps/app/src/features/chat`
- Docs: [CONTEXT](../../apps/app/src/features/chat/.context/CONTEXT.md), [AGENTS](../../apps/app/src/features/chat/AGENTS.md)
- Machines: [chat](../../apps/app/src/features/chat/.context/state-machines.md), [composer toolbar](../../apps/app/src/features/chat/composer/toolbar/.context/state-machines.md)

## agents

The Agent picker, Agent identity, what Mars made of each Agent or skill file, and Save.

A new chat records exactly which Agent, and which saved revision of it, the writer picked. The
Agents tab (in the project's sidebar) and an open Agent file read each file's verdict and each
package's Save state from here, and Save through it; a new Agent or skill file starts from a
template written here.

- Kind: feature
- Paths: `apps/app/src/features/agents`
- Docs: [CONTEXT](../../apps/app/src/features/agents/.context/CONTEXT.md), [AGENTS](../../apps/app/src/features/agents/AGENTS.md)
- Machines: [package Save word](../../apps/app/src/features/agents/.context/state-machines.md)

## project

The workspace shell.

Main and side panes, sidebar, tabs, Works and routing.

- Kind: context
- See: [project](app.md#project)

## client

Talking to the server.

HTTP clients, query hooks and the thread store.

- Kind: context
- See: [client](app.md#client)

## shared

Shared UI and helpers.

The group of `components`, `hooks`, `lib` and `rich-content`.

- Kind: context
- See: [shared](app.md#shared)

## documents

Editor and draft review.

The group of `editor`, `draft-review` and `links`.

- Kind: context
- See: [documents](app.md#documents)

## server

The server.

HTTP, the thread socket and the Loro socket.

- Kind: context
- See: [server](system.md#server)
