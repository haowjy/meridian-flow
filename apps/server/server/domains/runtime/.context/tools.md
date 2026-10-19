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
  list/show run; model `work switch` resolves and asks but never rebinds.

Advertisement and the per-turn gate use this policy. Dispatch and direct
executor calls do not silently reapply it; callers must choose the policy seam.
`ask_user` remains unadvertised until its interrupt rework.

## Document and cost boundaries

`read` is non-mutating; all `write` commands mutate through agent-edit. Source
text for copy/insert/replace is read as nodes and never passes through model
text. File destinations and grants come from file-policy, and all document
results use the typed agent-edit contract. `ls`, `search`, and `work` return
contract-shaped values with model-facing renderers that omit internal IDs and
add detail only for explicit `verbose` requests. A Work has no write mode of its
own: the chat's mode is in its work context (D62).

Document inverse commands use `write undo/redo` and `write revert`; model-only
handles select edits, and the command is all-or-nothing. Skills retain Mars
filenames while `skills://` exposes the document codec's names.

Tool policy does not gate model-call cost. `turn-accounting.ts` uses
`CreditLedger` and `TreeBudget`; `costing/` resolves token rates and applies the
fixed 1.15 multiplier before ledger debit. `Usage` is the shared runtime DTO,
and pricing rejects a negative uncached remainder rather than clamping it.

## Chat notes addresses

`$THREAD` and `$PARENT` expand only at address/href intake from prepared chat
scope, before parsing and file-policy selection. The server-only notes-scope
reader supplies current and derivation-source locations; uploads still use the
top primary chat.
Both policy and the ContextPort receive the same variable map. Editor holders,
admission references and keep-open lines are canonical-only.

The model uses `scratch://$THREAD/` for its own notes and `$PARENT` for the
originating chat's notes (the acted-on source for fork/handoff, even when its
cutoff turn was inherited; no parent on an ordinary root). Forks and handoffs
best-effort copy that source folder into their own folder before creation
returns. Copies have independent identity/history and grant no read credit.
Subagents start without a copy. A creation seed names the originals' canonical
address, which remains usable if copying failed. Permissions remain
owner-wide. Bare Scratch remains owner-wide and rebinding moves nothing.
Results carry canonical addresses; model prose, note links and keep-open lines
should reuse them. AI-written link preparation and assignment share the same
map. `return_result` accepts raw artifact strings, expands them in its handler,
then applies the unchanged canonical capture schema before saving object refs.

`persistToolOutcome` owns persisted and live non-executed results. Permission
denials remain errors with `permission.denied`; notes-held results use
`{ refusal: "notes_step" }`, a non-error notice and no denial event.

## Notes-step gate

During an accepted notes continuation, the sequential dispatch loop consults
`notesStepAddresses` before save boundaries or ordinary tool policy. The adapter
proves every path against scoped variables and canonical owner/thread coordinates
without allocating folders. Only read/write/ls/search qualify; search needs an
explicit scope and writes check source paths too. Out-of-folder or malformed
addresses and other calls get the neutral typed held result, not execution or
a permission event. Admission grants no Agent or file permission.
