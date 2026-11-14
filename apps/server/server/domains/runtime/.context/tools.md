# Tools, permissions, and cost

This context covers runtime registration/execution, per-turn access policy, and
metering. Spawn and history details live in [spawn](spawn.md) and [history
tools](history-tools.md).

## Registry and result boundary

`ToolRegistry` is a name-keyed map; duplicate names fail. Registrations provide
the published Zod input, execution handler, capability, timeout/sequential
flags, advertisement, typed-result renderer, and history classification.
Composition supplies every core handler; schema-only stubs are not advertised.

Dispatch returns both `content` (what the model saw: text parts, and media parts
once a tool produces them) and typed `result` (including errors). A registration's
`renderResult` returns the parts; a tool with no renderer gets its JSON as one text
part (`tools/tool-content.ts`). `content` is frozen when the block is stored and
nothing rewrites it (compaction's elisions replace it in the projected request only); history and compaction read it as
text (`toolContentText`: a media part reads as its name, type and size), while the
app reads `result` and never `content`. Refusals bypass custom
renderers and retain details on the typed result. Executor-owned timeout/abort/
throw failures use a registration formatter when one exists. Document handlers
keep the typed `meridian.agent-edit.v1` envelope for these failures.

Tools are grouped by owner: core `read`/`write`/`work` and listing/`grep`,
spawn/history tools, and the `skill` adapter for retained `skills://` files.
The model's skill path is read-only; `write` and `grep` refuse it. The
canonical tool schemas live in runtime and their handlers are bound from
`lib/model-tools`.

## Permissions

Three checks are independent: the agent must have the tool, the file policy must
allow the target, and the action policy must allow the operation.

- `projectToolPolicy` computes the per-turn tool set from the catalog, explicit
  allow-list, denials, disabled tools, and `return_result` for subagents.
  Unknown allow-list names refuse; unknown deny-list names deny nothing. Child
  tools must be a subset of the parent.
- Agent `permission` (`read` or `edit`) is monotone through the delegation
  chain and feeds file-policy per call. A read chain cannot write files except
  its own scratch where the file-policy contract allows it.
- `actionPolicy` gates non-file actions. Work changes are denied to read chains;
  list/show run. An edit Agent can switch its chat's Work and queue its chat's
  write mode for the next reply.
  An action-policy refusal is `permission_denied` with reason `action_denied`.

Advertisement and the per-turn gate use this policy. Dispatch and direct
executor calls do not silently reapply it; callers must choose the policy seam.
`ask_user` creates a durable question for a primary chat and ends that execution.
One call carries 1–4 questions (`questionAskPayloadSchema`, the one schema for the tool's
input and the stored payload), each with 2–4 options and an optional `recommended`. They
are one ask row: the writer answers the set with one submission, and the tool result is
`{answers: [{question, answer, free_text?, skipped?, timed_out?, unsent_text?}]}`, one entry per question
in order (flags and extra keys appear only when true), each echoing its question text. The answer's tool result is written onto the asking turn before an internal
continuation starts through ordinary request assembly. The tool and the Mars
capability share one name. Subagents never get `ask_user`
(`projectToolPolicy`): a child does its task with reasonable calls, or stops and
says in its report what is missing (`SUBAGENT_GUIDANCE`). The parent carries on
from the report: it does the work itself, sends the child what it needs, or asks
the writer with its own `ask_user` (the spawn description says so).

A question ask times out on a clock the server owns (`asks/ask-deadline.ts`): 4 minutes
idle, restarted by each `ask.presence` message the takeover sends while the writer is active
on the page (any pointer, key, wheel or touch, at most one per 30 s; not `scroll`, which the page causes itself), and never past 55 minutes after the ask opened (`asks.opened_at`). A presence
message that carries `answers` (sent only when the writer changed one) also stores them
(`asks.draft_answers`); one without leaves the stored answers alone, so a tab that only sees
activity can't overwrite newer answers from another tab or device. It publishes
`ask.updated` whenever the message carries `answers` (the echo is the sender's ack, even when
the answers equal the stored ones), and otherwise only when the deadline crosses a 30 s step (the
deadline is whole seconds). The stored answers go to the owner's clients as
`ThreadAsk.draftAnswers`. A refused presence is logged (`ask.presence.refused`, with its reason); no frame goes
back. When the deadline passes, `expireDue` resolves
from the stored answers: a held option or skip stands as the writer's answer; held typed words
become `unsent{text}` (the model gets `answer: null` with the words in `unsent_text` and `timed_out`, the receipt says
they weren't sent, and they return to the composer); every other question takes its
Recommended option (`timeout{label|null}`). A presence that races the sweep
settles under the thread lock; the sweep resolves only an ask whose deadline is still due.
Permission asks have no deadline and take no presence.
The tool has one input shape (`questions`, 1-4), in every thread's stored definition too.

A tool asks through its handler's `request` capability (`RequestToolHandlerContext`):
the ask service's one creation call (`AskService.request`) opens the question or
permission request it names and returns the deferred disposition, which settles
the execution. The batch rule keys on that disposition, not on the tool: the first
request in a provider batch defers it, and a later one (`one_request_at_a_time`) is
refused as that call's tool result while the reply continues (`loop/tool-dispatch.ts`,
`RequestBatch`). So two `work` calls that each need permission in one response open
one request; the second gets the refusal. The app maps that code, `thread_stopped`,
`tool_timeout`, `tool_arguments_parse` (arguments that were not JSON, read like a schema
failure) and an action-policy `permission_denied` to its own localized sentence
on the failed row. A caught exception, in the executor or a handler's own catch,
carries `TOOL_EXCEPTION_CODE` (`tool_exception`), and the app shows generic copy for
it, never its message: the message can carry SQL or internal ids. Every other
failure, including a deliberate refusal without its own code (`tool_error`), shows
its message.

The action-policy `ask` decision is separate from the question tool. The `work`
handler holds the `request` capability. It resolves every command's target first
(`resolveWorkCommand`), so an unknown handle or a switch's no-op answers before policy;
then, for an action the policy asks about and the project holds no grant for, it
requests a permission ask. A grant is the writer's own standing answer, so it holds in
subagents too; without one a subagent gets a fixed denial that tells it to report what
it needed. The payload is facts the app words in its locale (agent, action, the target
Work as named then, and per action the fields it sets); the server-only command is the
command alone with its target pinned by id, parsed with `permissionWorkCommandSchema`
when read. The project is the asking chat's.

Allow runs the saved command through the same executor as a direct call
(`executeWorkCommand`), as the agent's action: an Allowed `write_mode` queues an agent
switch and leaves the Work's default mode alone, and the ask's receipt records that
the writer allowed it. `createAllowedWorkExecutor` (`lib/model-tools/work-tool.ts`)
runs it in a savepoint of the answer transaction, and the tool executor's
`handlerToolResult` shapes it as that call's result would be. A domain refusal rolls
the savepoint back, writes and after-commit effects included, and only then becomes
the error tool result, so the answer still commits; any other failure rolls back the
answer. Allow always also stores a project-and-action grant, even when the action was
refused. Base deny still wins, and an `ask` decision on an action that can't ask
throws. No current action maps to `ask`.

`work.delete` can't ask: it is not a `PermissionAction`, and the policy table's type
rejects an `ask` row for it. A deleted Work restores for 30 days from its receipt.
This also keeps an answer to one thread lock: an Allow never ends a lineage, so it
takes only the asking chat's lock, as every answer does.

## Document and cost boundaries

`read` is non-mutating; `write`'s text commands mutate through agent-edit (`move` and
`delete` are host commands, below), and every result renders through it. Source
text for copy/insert/replace is read as nodes and never passes through model
text. File destinations and grants come from file-policy, and all document
results use the typed agent-edit contract. `ls`, `grep`, and `work` return
contract-shaped values with model-facing renderers that omit internal IDs and
add detail only for explicit `verbose` requests. A Work has no write mode of its
own: the chat's mode is in its work context.

Document inverse commands use `write undo/redo` and `write revert`; model-only
handles select edits, and the command is all-or-nothing. The tree commands
(`write move`, `delete`, `restore`, and `create` of a folder) are host commands
(`lib/model-tools/tree-commands.ts`, the core in `domains/context/tree/tree-commands.ts`).
Each call is one document command (`commands`, `collab/.context/model-edits.md`) with
its records admitted at the call; nothing waits for the reply's save, and a failed reply leaves
what its calls did. A path resolves through the
names the model was shown: `ls` and every tree result record, per chat, which name meant
which node (host-only evidence, `observation_frontiers` room `tree`, never shown to the
model), so a stale path reaches the node the model meant and a name reused for another
document is refused as `path_changed`. Every tool that prints a path
records exactly the names it printed, from the nodes that produced them (`printedDelta`), and
a name shown in the other view still means its node in this one. The call keeps a receipt
(`tree_edit_receipts` and one row per node it changed, `collab/.context/reversal.md`); `undo`,
`redo` and `revert` choose from the node's one history across text and tree edits, and a call
that takes both back is one command, so a refusal of its text half takes the tree half back
with it. A command that refuses stores nothing (the effect's savepoint rolls back, and
`SourceTree.run` drops what `make` wrote). In a draft-mode chat the
records are the Work's branch's and live is untouched until the user applies them; Scratch
and upload content stays live while its placement can be drafted
(`collab/.context/apply.md`). Skills retain Mars
filenames while `skills://` exposes the document codec's names.

Command details the model sees:

- Block `replace` with empty content refuses and points to `remove`, because
  the codec parses `""`, `"\n"` and `" "` alike into one empty paragraph;
  `replace(find, content="")` still deletes text.
- Block copy (`from` on `insert` or `replace`) copies ProseMirror nodes and
  positions with `after`/`before` or `in`/`#fragment`, never `find`; copies are
  AI-marked and leave comments, authorship and hashes behind. Document copy
  keeps the source's type; a binary copy duplicates its storage object live,
  with no write handle, and refuses an existing destination.
- `move`: a `path` that names an existing folder (always, for a document; for a folder, one that is not the folder moved) is the folder the node goes into under its own name; any other `path` is where the node itself ends up, name included, and the same `path` with `position` is a reorder. `position.sibling` is looked up by name in the destination folder. Moves into a folder deleted since are made and the folder stands (`kept:`). A document also moves between a project's files and `user://` (`lib/model-tools/tree-across-lists.ts`, `port.moveAcrossLists`: two lists, one transaction); a folder does not.
- When a deleted document and a moved one both left a path, `undo` on that path
  picks the deleted one, so moving a blocker aside never makes `undo` pick the
  blocker.
- A server-side read of a writer's @-mention calls the same read and renderer
  as the `read` handler instead of building tool arguments. That includes a binary file: one
  decision (`lib/model-tools/binary-read.ts`) gives the model the file as media, its extracted
  text, or a description, for an @-mention and a `read` alike. The reader asks for the thread's
  model lazily (`lazyThreadModel`), only when the file turns out to be binary.

Tool policy does not gate model-call cost. `turn-accounting.ts` uses
`CreditLedger` and `TreeBudget`; `costing/` resolves token rates and applies the
fixed 1.15 multiplier before ledger debit. `Usage` is the shared runtime DTO,
and pricing rejects a negative uncached remainder rather than clamping it.
