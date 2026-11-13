# Server

One Nitro process. Its 17 domains are grouped by the writer work they serve, and a group opens a
page of its domains. Follow the numbers for one chat turn: the message arrives (1), a route admits
it (2), conversation asks the model for a reply (3), the model's tool calls read and edit documents
(4), the edit is journaled in Postgres (5), and the reply (6) and the edit (7) stream back to the
browser. Step by step: [a message becomes an edit](flows/message-becomes-edit.md). Imports that
break the written rules, among them a cycle of six domains, are on [dependencies](dependencies.md).

```mermaid
flowchart LR
  browser["browser<br/><small>the writer's tab</small>"]:::context
  routes["routes<br/><small>front door: authenticates, calls a domain</small>"]:::module
  lib["lib<br/><small>builds every domain and hands it to the routes</small>"]:::module
  conversation["conversation<br/><small>chat turns and the model</small>"]:::group
  documents["documents<br/><small>live documents, drafts, who may edit</small>"]:::group
  workspace["workspace<br/><small>projects, Works, what was open</small>"]:::group
  files["files<br/><small>import, export, uploads, bytes</small>"]:::group
  account["account<br/><small>credits, settings, safe logging</small>"]:::group
  models["models<br/><small>the AI providers</small>"]:::context
  postgres["postgres<br/><small>the one database</small>"]:::context
  objectstore["objectstore<br/><small>file bytes</small>"]:::context
  browser -->|"1. sends the message"| routes
  routes -->|"2. admits it and wakes the run"| conversation
  conversation -->|"3. asks for a reply"| models
  conversation -->|"4. reads and edits documents for the model"| documents
  documents -->|"5. journals the edit"| postgres
  conversation -->|"6. streams the reply"| browser
  documents -->|"7. pushes the edit to open documents"| browser
  lib -->|"builds the domains for"| routes
  conversation -->|"reads the chat's Work"| workspace
  conversation -->|"charges credits"| account
  workspace -->|"archives and deletes a Work's documents"| documents
  files -->|"writes an imported tree"| documents
  files -->|"stores and reads bytes"| objectstore
  note1["The routes get every domain from lib. By the written rule domains do not import lib; the one exception is listed on the dependencies page."]:::note
  note1 -.- lib
  note2["A Work is one task's editing context in a project: it groups chats and owns shared drafts. That is why conversation and documents both ask workspace."]:::note
  note2 -.- workspace
```

## conversation

Chat turns: admitting a message, the run with the model, the saved thread.

`runtime`, `threads`, `notices` and `packages`. A message is admitted, a run asks the model with tools, and the threads domain journals the events and pushes them to the browser. `lib/model-tools` binds the model's `read` and `write` tools to the documents group.

- Kind: group
- Paths: `apps/server/server/domains/runtime`, `apps/server/server/domains/threads`, `apps/server/server/domains/notices`, `apps/server/server/domains/packages`
- Opens: [Conversation](server-conversation.md)

## documents

The writer's documents: live Yjs rooms, drafts, the context filesystem and who may edit what.

`collab`, `context` and `file-policy`. The model and the writer both edit through collab; context gives documents their addresses; file-policy answers whether this actor may read or write this document.

- Kind: group
- Paths: `apps/server/server/domains/collab`, `apps/server/server/domains/context`, `apps/server/server/domains/file-policy`
- Opens: [Documents](server-documents.md)

## workspace

Projects and Works: who owns what, and what the writer had open.

`projects`, `working-set` and `recent-documents`. A Work is a task-scoped editing context in a project; these domains gate writes on it and remember what the writer was looking at.

- Kind: group
- Paths: `apps/server/server/domains/projects`, `apps/server/server/domains/working-set`, `apps/server/server/domains/recent-documents`
- Opens: [Workspace](server-workspace.md)

## files

Bytes in and out: import, export, uploads and the object store.

`import`, `export`, `file-intake` and `storage`. A writer imports a folder, exports a ZIP, or attaches an image; these domains classify, move and keep the bytes.

- Kind: group
- Paths: `apps/server/server/domains/import`, `apps/server/server/domains/export`, `apps/server/server/domains/file-intake`, `apps/server/server/domains/storage`
- Opens: [Files](server-files.md)

## account

What belongs to the account and the operator: credits, settings, and the safe event stream.

`billing`, `preferences` and `observability`. Billing is the credit ledger that runs consume; observability sanitizes every event so writer text stays out of logs.

- Kind: group
- Paths: `apps/server/server/domains/billing`, `apps/server/server/domains/preferences`, `apps/server/server/domains/observability`
- Opens: [Account](server-account.md)

## routes

The front door: Nitro file routes, startup, request observability and CORS.

The startup plugin boots the process and, in a built server, ends it on a boot failure. A route authenticates, runs the domain's gate and returns `@meridian/contracts` shapes only. A route that touches a document also asks file policy.

- Kind: module
- Paths: `apps/server/server/routes`, `apps/server/server/plugins`, `apps/server/server/middleware`
- Docs: [server CONTEXT](../../apps/server/.context/CONTEXT.md), [server AGENTS](../../apps/server/AGENTS.md)
- Drift: the startup plugin imports `routes/ws/yjs`, so plugins depend on routes.

## lib

The composition root: builds every domain into `AppServices` and gives it to the routes.

`compose.ts` builds `AppServices` and `app.ts` holds it as the process singleton. It is the one place allowed to import every domain's adapters, and also holds auth, the route cores (`*-route.ts`) and `lib/model-tools`, which binds the model's tools to the documents. `shared/` beside it holds small helpers: the Drizzle transaction wrapper, keyed mutexes and `lockSeamWorks`, which a new write path calls before any other lock.

- Kind: module
- Paths: `apps/server/server/lib`, `apps/server/server/shared`
- Docs: [lib CONTEXT](../../apps/server/server/lib/.context/CONTEXT.md)
- Machines: [lib](../../apps/server/server/lib/.context/state-machines.md)
- Drift: `shared/work-lifecycle-lock.ts` imports `projects/domain/work-lifecycle.ts` while `projects` imports `shared`, so the helper layer reaches up into a domain. No written rule covers `shared/`.

## browser

The writer's browser tab.

Sends HTTP requests, holds the thread socket and the Yjs socket.

- Kind: context
- See: [browser](system.md#browser)

## models

The model providers.

Called through one gateway owned by the runtime domain.

- Kind: context
- See: [models](system.md#models)

## postgres

The one database.

Every domain's tables; the thread hub is woken by a Postgres notification.

- Kind: context
- See: [postgres](system.md#postgres)

## objectstore

Where file bytes live.

Behind `ObjectStorePort` in the files group.

- Kind: context
- See: [objectstore](system.md#objectstore)
