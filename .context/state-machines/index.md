# State machines

Every state machine in the repository: anything with named states and rules for moving
between them, whether a status column, a reducer, a connection or a lifecycle spread over two
fields. Each `state-machines.md` sits in the `.context/` beside the code that owns the
transitions, draws the machine as the code has it and says what a wrong edit breaks. Change
the code and the diagram in the same commit. Product words are in the
[glossary](../glossary.md).

## Patterns

Four shapes recur. Each page draws the shape, gives its rules and lists the machines that
have it:

- [A command that may have landed](command-that-may-have-landed.md): an optimistic action whose
  request can go unanswered.
- [A job worked under a lease](job-under-a-lease.md): durable work that one process at a time
  may do, and that survives the process dying.
- [A connection that replays](connection-that-replays.md): an ordered stream over a connection
  that drops.
- [Load status](load-status.md): fetched once, then shown.

## Server

| Machine | State of | Page |
|---|---|---|
| Turn status | One turn: `pending` to `complete`, `cancelled`, `error` or `awaiting_answer` | [runtime](../../apps/server/server/domains/runtime/.context/state-machines.md) |
| Run lease and phase | Whether a thread has a live run, and what it is doing | [runtime](../../apps/server/server/domains/runtime/.context/state-machines.md) |
| Ask | One question or permission request from the model to the writer | [runtime](../../apps/server/server/domains/runtime/.context/state-machines.md) |
| User-turn admission | One writer submission, admitted exactly once | [runtime](../../apps/server/server/domains/runtime/.context/state-machines.md) |
| Media inclusion | Whether one picture or tool-result media part is in the model request | [runtime](../../apps/server/server/domains/runtime/.context/state-machines.md) |
| Spawn status | What became of one subagent, as its parent sees it | [runtime](../../apps/server/server/domains/runtime/.context/state-machines.md) |
| Connection status | Whether a writer's MCP connection works: no result, connected, unreachable, needs sign-in | [mcp](../../apps/server/server/domains/mcp/.context/state-machines.md) |
| Thread trash | Whether a chat is in the Trash | [threads](../../apps/server/server/domains/threads/.context/state-machines.md) |
| Work archive, Work delete | Whether a Work is available | [projects](../../apps/server/server/domains/projects/.context/state-machines.md) |
| Import, import entry | An import job and each file in it | [import](../../apps/server/server/domains/import/.context/state-machines.md) |
| Upload intake | One uploaded file, from a reserved address to a file in the project | [context/uploads](../../apps/server/server/domains/context/uploads/.context/state-machines.md) |
| Document content | Whether a document is shown, in Trash, in no view, or its content released | [context](../../apps/server/server/domains/context/.context/state-machines.md) |
| Thread subscription, server half | One subscription on one WebSocket peer | [lib](../../apps/server/server/lib/.context/state-machines.md) |
| A joined `/ws/loro` room | One room a socket joined (a document's Live or fork, or a tree list): join, batches, how it ends | [lib](../../apps/server/server/lib/.context/state-machines.md) |

## Packages

| Machine | State of | Page |
|---|---|---|
| Command | One command the server may not have received, from the journal to its stored outcome (Work commands today) | [command-driver](../../packages/command-driver/.context/state-machines.md) |
| Thread socket | The shared WebSocket and its handshake | [thread-client](../../packages/thread-client/.context/state-machines.md) |
| Thread subscription, client half | One thread's subscription and replay | [thread-client](../../packages/thread-client/.context/state-machines.md) |
| Hand-back and Stop commands | One Stop press, or one request to take queued messages back | [thread-client](../../packages/thread-client/.context/state-machines.md) |

## App

| Machine | State of | Page |
|---|---|---|
| Document session status | One open document's connection to the server | [core/editor](../../apps/app/src/core/editor/.context/state-machines.md) |
| Release | Whether this tab's code is current, deployed under, or must reload | [client/release](../../apps/app/src/client/release/.context/state-machines.md) |
| Account session runtime | Whether the account's document sessions take new work: open, closing, closed | [core/editor](../../apps/app/src/core/editor/.context/state-machines.md) |
| Tree list connection | One tab's view of its list's connection: waiting, synced, offline, rebuilding | [core/tree-list](../../apps/app/src/core/tree-list/.context/state-machines.md) |
| Sync pill outage phase | Whether the pill is reporting or confirming an outage | [features/editor](../../apps/app/src/features/editor/.context/state-machines.md) |
| Upload store | One file being sent from the editor or composer | [core/uploads](../../apps/app/src/core/uploads/.context/state-machines.md) |
| Chat submission | One sent message, from the journal to the server's answer | [client/chat-submissions](../../apps/app/src/client/chat-submissions/.context/state-machines.md) |
| Composer toolbar | Which toolbar surface is open, and whether it is locked | [composer-toolbar](../../apps/app/src/components/app/composer-toolbar/.context/state-machines.md) |
| Composer Work binding | The Work picker while a chat changes Work | [features/chat](../../apps/app/src/features/chat/.context/state-machines.md) |
| Queued control | One compaction or write-mode switch waiting behind a running reply | [features/chat](../../apps/app/src/features/chat/.context/state-machines.md) |
| Fork and handoff creation | A chat created from another, before the server has it | [features/chat](../../apps/app/src/features/chat/.context/state-machines.md) |
| Import creation, local upload phase | This tab's part in an import | [features/import](../../apps/app/src/features/import/.context/state-machines.md) |
| An Apply's Undo | One press Apply: in force, Undo or Redo in flight, taken back, or ended; every surface that undoes it reads it | [features/draft-review](../../apps/app/src/features/draft-review/.context/state-machines.md) |
| Package Save word | What the last Save or Undo of one Agent package says where its state shows | [features/agents](../../apps/app/src/features/agents/.context/state-machines.md) |
| Held paint | A document still painting a draft that left its list | [features/project](../../apps/app/src/features/project/.context/document-paint-state-machine.md) |
| Sidebar version | Whether the sidebar and its actions show live or the picked Work's tree, and sidebar Undo | [features/project](../../apps/app/src/features/project/.context/tree-version-state-machine.md) |
| Panes | What main and the side show, and where an opened item lands | [features/project](../../apps/app/src/features/project/.context/pane-state-machine.md) |
| Live document binding | One editor pane's hold on an open document | [features/project/context](../../apps/app/src/features/project/context/.context/state-machines.md) |
| Server feed | The debug overlay's event stream | [features/debug](../../apps/app/src/features/debug/.context/state-machines.md) |

## Site

| Machine | State of | Page |
|---|---|---|
| Landing autoplay | Whether the landing page is scrolling its story by itself | [landing](../../apps/www/src/features/landing/.context/state-machines.md) |

## What is left out

Named states that no code steps: they are computed from other state on each read. Examples
are the handoff brief card and compaction divider (from a turn's status), the import word the
writer sees, undo part state in agent-edit, the state of a change of an AI edit in a draft (drawn in
[collab reversal](../../apps/server/server/domains/collab/.context/reversal.md)) and the Stop button's status. Two-way toggles and
one-shot results are left out too.
