# State machines

Every state machine in the repository, with a link to the diagram beside its code. A machine
here is anything with named states and rules for moving between them, whether or not the code
calls it one: a status column, a reducer, a connection, a lifecycle spread over two fields.

Each `state-machines.md` sits in the `.context/` of the directory that owns the transitions.
It draws the machine as it is in the code now and says what a wrong edit breaks. Change the
code and the diagram in the same commit.

## Patterns

Four shapes recur. Each is drawn once, with the rules every instance follows and the reason
for each:

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
| Ask | One question or permission request | [runtime](../../apps/server/server/domains/runtime/.context/state-machines.md) |
| User-turn admission | One writer submission, admitted exactly once | [runtime](../../apps/server/server/domains/runtime/.context/state-machines.md) |
| Spawn status | What became of one subagent run | [runtime](../../apps/server/server/domains/runtime/.context/state-machines.md) |
| Thread archive, thread trash | How a thread is filed | [threads](../../apps/server/server/domains/threads/.context/state-machines.md) |
| Work archive, Work delete | Whether a Work is available | [projects](../../apps/server/server/domains/projects/.context/state-machines.md) |
| Import, import entry | An import job and each file in it | [import](../../apps/server/server/domains/import/.context/state-machines.md) |
| Upload intake | One uploaded file, from reservation to Context | [context/uploads](../../apps/server/server/domains/context/uploads/.context/state-machines.md) |
| Draft, branch | Whether a draft or branch still accepts writes | [collab](../../apps/server/server/domains/collab/.context/state-machines.md) |
| Branch command | One idempotent review command | [collab](../../apps/server/server/domains/collab/.context/state-machines.md) |
| Draft write journal row | Whether a journalled write awaits rollback | [collab](../../apps/server/server/domains/collab/.context/state-machines.md) |
| Thread subscription lease | One subscription on one WebSocket peer | [lib](../../apps/server/server/lib/.context/state-machines.md) |
| Draft room handshake | Whether a connection may send edits to a draft room | [lib](../../apps/server/server/lib/.context/state-machines.md) |

## Packages

| Machine | State of | Page |
|---|---|---|
| Thread socket | The shared WebSocket and its handshake | [thread-client](../../packages/thread-client/.context/state-machines.md) |
| Thread subscription | One thread's subscription and replay | [thread-client](../../packages/thread-client/.context/state-machines.md) |
| Hand-back and Stop commands | One "take it back" or Stop press | [thread-client](../../packages/thread-client/.context/state-machines.md) |
| Response | One model response's staged document writes | [agent-edit](../../packages/agent-edit/.context/state-machines.md) |
| Server hold | What the server holds under a locally minted id | [resource-replica](../../packages/resource-replica/.context/state-machines.md) |
| Resource lifecycle | Whether a document or folder exists for the server | [resource-replica](../../packages/resource-replica/.context/state-machines.md) |
| Namespace intent | One place, move, delete or copy on its way to the server | [resource-replica](../../packages/resource-replica/.context/state-machines.md) |

## App

| Machine | State of | Page |
|---|---|---|
| Document session status | One open document's connection to the server | [core/editor](../../apps/app/src/core/editor/.context/state-machines.md) |
| Draft room read | Whether a draft's room can be shown and acted on | [core/editor](../../apps/app/src/core/editor/.context/state-machines.md) |
| Sync pill outage phase | Whether the pill is reporting or confirming an outage | [features/editor](../../apps/app/src/features/editor/.context/state-machines.md) |
| Upload store | One file being sent from the editor or composer | [core/uploads](../../apps/app/src/core/uploads/.context/state-machines.md) |
| Chat submission | One sent message, from the journal to the server's answer | [client/chat-submissions](../../apps/app/src/client/chat-submissions/.context/state-machines.md) |
| Creation record | Something created that the server has not confirmed | [client/creation](../../apps/app/src/client/creation/.context/state-machines.md) |
| Composer toolbar | Which toolbar surface is open, and whether it is locked | [composer-toolbar](../../apps/app/src/components/app/composer-toolbar/.context/state-machines.md) |
| Composer Work binding | The Work picker while a chat changes Work | [features/chat](../../apps/app/src/features/chat/.context/state-machines.md) |
| Queued control | One queued compaction or write-mode switch | [features/chat](../../apps/app/src/features/chat/.context/state-machines.md) |
| Fork and handoff creation | A chat created from another, before the server has it | [features/chat](../../apps/app/src/features/chat/.context/state-machines.md) |
| Import creation, local upload phase | This tab's part in an import | [features/import](../../apps/app/src/features/import/.context/state-machines.md) |
| Apply click command | One Apply or Undo click on a draft change | [features/draft-review](../../apps/app/src/features/draft-review/.context/state-machines.md) |
| Live document binding | One host's hold on an open document | [features/project/context](../../apps/app/src/features/project/context/.context/state-machines.md) |
| Route selection during removal | Which document the route is trying to show | [features/project/context](../../apps/app/src/features/project/context/.context/state-machines.md) |
| Rename and move feedback | What to show for one rename or move | [features/project/context](../../apps/app/src/features/project/context/.context/state-machines.md) |
| Server feed | The debug overlay's event stream | [features/debug](../../apps/app/src/features/debug/.context/state-machines.md) |

## Site

| Machine | State of | Page |
|---|---|---|
| Landing autoplay | Whether the landing story is scrolling itself | [landing](../../apps/www/src/features/landing/.context/state-machines.md) |

## What is left out

A union of names is not a machine when nothing steps it. These are computed from other state
each time they are read, and their pages say so where it helps: the chat's brief card and
compaction divider (from a turn's status), the import word the writer sees (from the server's
summary and the local phase), undo part state in agent-edit (from the document), and the Stop
button's status (from the run state). Two-way toggles and one-shot results (a clipboard write,
a port release) are left out too.
