# Tools, permissions, and cost

The tool registry and executor, the per-turn permission policy, and how model
calls are metered. Spawn tools are in [spawn](spawn.md); history inspection
tools are in [history tools](history-tools.md).

## Registry and executor

| Concern | Detail |
|---|---|
| `ToolRegistry` | Name-keyed map. Duplicate names throw immediately. `getDefinitions()` advertises only server-executable registrations whose `advertise !== false`. |
| `ToolExecutor` | Dispatches `ToolCallInput` to registered handlers with timeout, abort, sequential execution, and capability-gated context injection. |
| `ToolRegistration` | `source: "core" | "spawn" | "skill"`, `definition`, `input` (the zod schema both published and parsed), `execution`, optional `timeoutMs`, `sequential`, `advertise`, one privileged `capability`, `renderResult` (typed result → the model's text), `historyKind`, and optional `formatExecutionError` when a tool owns its model-facing error protocol. |
| Core handlers | The strict `work` command union, the `read` and `write` document definitions, and other definitions live in `tools/core-tools.ts`; composition wires their handlers through `lib/wired-core-tools.ts`. |
| Skills | References are retained at binding. `createSkillToolRegistrations` registers the `skill` tool (`source: "skill"`) for primaries and subagents alike; it loads a SKILL.md body only when the slug is in the thread's bound `skills.available` and `model-invocable` is not false, and returns plain text: the body, then one `skill({"slug":…,"resource":…})` call per resource file. `resource` opens a UTF-8 file under an available or preloaded skill's directory. `skills.load` bodies are baked into the first prompt ([request assembly](request-assembly.md)). No legacy `invoke` registration or mutable skill catalog participates in preparation. |
| Spawn tools | `tools/spawn-tools.ts` registers `spawn`, `thread_message`, `return_result`, and `thread_report` with explicit privileged capabilities. `thread_message` `{ ref, message, mode }` puts a message into a thread (default `mode: background`); foreground targets a subagent in the caller's subtree and returns its report. `return_result` accepts Meridian document URI strings and validates them through the contracts capture schema before mapping them to `{ type: "object", uri }`. Invalid input returns a model-correctable tool error instead of aborting the child run. Neither spawn nor thread_message accepts an escalation patch. |
| Inspection tools | `tools/inspection-tools.ts` registers `thread_ls` and `thread_history` with repository and tokenizer ports at composition (`thread_report` registers with the spawn tools); see [history tools](history-tools.md). |
| Document text | `tools/document-text.ts` and `tools/history-summaries.ts`: each registration owns its `DocumentTextPolicy`, `historySummary` (the result after a history call line's `→`) and `historyKind` (`routine` calls are hidden in history by default); see [document text in history](document-text.md) and [history tools](history-tools.md). |

Every `ToolExecutionResult` carries `output` (what the model sees) and
`result` (the typed value, always set, errors included); dispatch persists
`result` on the `tool_result` block and the `tool.result` event, and every
reader (history summaries, `thread_history`, the app) reads `result`, never
`output` (D8, D43). With `renderResult`, `output` is its text; without, both
are the value. Parse failures return `invalid_arguments` with `result`
`{ error, issues }` and a rendered text. Timeout, abort, and thrown failures
belong to the executor; it delegates those to the registration's
`formatExecutionError` when present and otherwise uses the generic Meridian
error format. `read` and `write` own such a formatter, so every executor-owned
document failure is still a `meridian.agent-edit.v1` result rendered like any
other, without teaching the generic executor about agent-edit.

The core-tool publication boundary lives in `tools/core-tools.ts`: definitions,
names, and constraints are canonical there, but `createCoreToolRegistrations()`
requires handlers for every core tool. The composition root supplies executable
behavior; schema-only stubs are not advertised.

## Permissions

`loop/permissions/`: `projectToolPolicy` projects compiled Mars `tools` / `disallowed-tools` onto Flow tool names and the `work` command set. `read` is always advertised; `write` only when the existing `edit` policy allows it (until file permissions replace this, PR 2). A call to any tool the agent lacks, `write` included, is `permission_denied` with one message: `This agent has no "<tool>" tool, so it can't make this call. Tell the user you can't do this here.` `edit` also adds or removes Work mutation commands, and `advertiseTools` narrows the `work` schema, including its per-command descriptions, to the same set. Retained historical `read` policy metadata is inert. `commandSetForTool` is the single command mapping. Advertise and the per-turn permission gate (name + command) use that policy. `invocation-authority` validates that an invocation patch never grants the child more than the caller holds, applied only to the patch delta. Dispatch does not apply policy. The core catalogue stays policy-free.

## Policy and cost

- Tool policy is per-turn: `projectToolPolicy` → permission gate (`check` name,
  then command) → `persistToolRejection`. A missing, non-string, or unknown
  command is `invalid_arguments`; a recognized but disabled command or tool is
  `permission_denied`. Dispatch does not apply policy. Direct
  `toolExecutor.executeTool` does not apply policy.
- `ask_user` is never advertised until its rework (composer-attached answer
  input and defined subagent semantics,
  [#601](https://github.com/haowjy/meridian-flow/issues/601)), even when an
  Agent's Mars policy allows it (`project-tool-policy.ts`). The interrupt
  runtime and the app's interrupt card remain; re-enabling is that one line.
- Documents have two tools (D1): `read({ path, in?, around?, format?,
  version? })` never changes a document, and every `write` command (`create`,
  `copy`, `insert`, `replace`, `remove`, `undo`, `redo`) does. There is no
  `diff` and no whole-document delete; old `write({ command: "read" })` rows
  render through the generic fallback and nothing accepts them as input.
  `version` (also on `search` and `ls`) defaults to the version this thread's
  writes change; each document's destination comes from
  `domains/file-policy` (`scratch://` and `uploads://` are never drafted). Both parse their zod `input` in the
  executor; the handlers map `path` to the engine's `file`. `read`, the
  reference reader and copy sources (`from`) share one `readDocument` (D18).
  `from` on `insert`/`replace` and `copy` read the source as nodes and hand
  them to agent-edit, so copied text never passes through the model (D23,
  D24); a tracked `copy` is a staged create, a binary one goes through
  `domains/context/binary-copy.ts`. A source read never carries the write's
  tool call id, which keys the write's idempotency. Their handlers return the
  typed agent-edit result, and the registration's `renderResult` makes the
  model's text; the typed result is persisted beside it as `result` (D43).
  Reading does not expand URI, object, Project, owner, or document
  authorization, change Work binding, or change write mode.
- Model-call cost gating is not a `PermissionGate` method. The runtime uses
  `CreditLedger` plus `TreeBudget` (for spawn trees) through `turn-accounting.ts`
  and `ChildRunCoordinator`.
- `costing/` owns model token-rate resolution and applies the fixed 1.15
  `COST_MULTIPLIER` when converting raw provider USD-micro cost into metered
  millicredits before ledger debits. Billing owns only ledger behavior and route
  display conversion.
- `Usage` token counts are shared DTOs from `@meridian/contracts/runtime`.
  Because `inputTokens` is the inclusive total, pricing derives the uncached
  remainder by subtracting the cache counters, and rejects a negative result
  instead of clamping it — a clamp silently prices cached turns as free.
  Billing owns ledger behavior in `domains/billing`.
