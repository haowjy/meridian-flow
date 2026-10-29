# Tools, permissions, and cost

This context covers runtime registration/execution, per-turn access policy, and
metering. Spawn and history details live in [spawn](spawn.md) and [history
tools](history-tools.md).

## Registry and result boundary

`ToolRegistry` is a name-keyed map; duplicate names fail. Registrations provide
the published Zod input, execution handler, capability, timeout/sequential
flags, advertisement, typed-result renderer, and history classification.
Composition supplies every core handler; schema-only stubs are not advertised.

Dispatch returns both `output` (model text) and typed `result` (including
errors). It persists `result` on the tool-result block/event; history, the app,
and summaries read `result`, never parse `output`. Refusals bypass custom
renderers and retain details on the typed result. Executor-owned timeout/abort/
throw failures use a registration formatter when one exists. Document handlers
keep the typed `meridian.agent-edit.v1` envelope for these failures.

Tools are grouped by owner: core `read`/`write`/`work` and listing/search,
spawn/history tools, and the `skill` adapter for retained `skills://` files.
The model's skill path is read-only; `write` and `search` refuse it. The
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
The answer's tool result is written onto the asking turn before an internal
continuation starts through ordinary request assembly. The tool and the Mars
capability share one name. The action policy retains `ask` for future
actions, but no current action maps to it. Subagents never get `ask_user`
(`projectToolPolicy`): a child does its task with reasonable calls, or stops and
says in its report what is missing (`SUBAGENT_GUIDANCE`). The parent carries on
from the report: it does the work itself, sends the child what it needs, or asks
the writer with its own `ask_user` (the spawn description says so).

A tool asks through its handler's `request` capability (`RequestToolHandlerContext`):
the ask service's one creation call (`AskService.request`) opens the ask the
request names and returns the deferred disposition, which settles the execution.
The batch rule keys on that disposition, not on the tool: the first request in a
provider batch defers it, and a later one (`one_request_at_a_time`) is refused
as that call's tool result while the reply continues (`loop/tool-dispatch.ts`,
`RequestBatch`). The app maps that code, and `thread_stopped`, to its own localized sentence on
the failed row; an unexpected `tool_error` shows generic copy, never its message.

## Document and cost boundaries

`read` is non-mutating; `write`'s text commands mutate through agent-edit (`move` and
`delete` are host commands, below), and every result renders through it. Source
text for copy/insert/replace is read as nodes and never passes through model
text. File destinations and grants come from file-policy, and all document
results use the typed agent-edit contract. `ls`, `search`, and `work` return
contract-shaped values with model-facing renderers that omit internal IDs and
add detail only for explicit `verbose` requests. A Work has no write mode of its
own: the chat's mode is in its work context (D62).

Document inverse commands use `write undo/redo` and `write revert`; model-only
handles select edits, and the command is all-or-nothing. `write move` and
`write delete` (PR 3) are host commands (`lib/model-tools/namespace-commands.ts`):
they run at the call, record a tree entry on the document's stack inside the
mutation's own transaction, and mark the reply's scope as having writes
(`treeWrite`), so a later save boundary rotates it. In an auto-apply chat they go
through the live port. In a draft-mode chat their placement goes through the
chat's branch (`ContextPort.changeInBranch`): facts live on the Work's branch
row, never the mover, and live placement is untouched until the user applies
them (D26). Content destination is independent: Scratch and upload content stays
live while its placement can be drafted. The user applies or discards drafted
placement like any pending change (`collab/.context/apply.md`). A path no
visible document holds names, for undo/redo/revert only, the document this
chat's latest move or delete took away from it (`inverse-address.ts`). Skills retain Mars
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
- `move` refuses only a destination that cannot exist. The model sees
  `location_taken` (a document sits where the path needs a folder) and
  `destination_missing` (a missing folder); Apply and the reversal paths call
  the same cases `ancestor_taken` and `folder_missing`. A folder source refuses
  as `source_is_folder`. Neither `move` nor `delete` runs the shown-view check.
- When a deleted document and a moved one both left a path, `undo` on that path
  picks the deleted one, so moving a blocker aside never makes `undo` pick the
  blocker.
- A server-side read of a writer's @-mention calls the same read and renderer
  as the `read` handler instead of building tool arguments.

Tool policy does not gate model-call cost. `turn-accounting.ts` uses
`CreditLedger` and `TreeBudget`; `costing/` resolves token rates and applies the
fixed 1.15 multiplier before ledger debit. `Usage` is the shared runtime DTO,
and pricing rejects a negative uncached remainder rather than clamping it.
