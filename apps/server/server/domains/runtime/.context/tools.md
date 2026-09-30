# Tools, permissions, and cost

The tool registry and executor, the per-turn permission policy, and how model
calls are metered. Spawn tools are in [spawn](spawn.md); history inspection
tools are in [history tools](history-tools.md).

## Registry and executor

| Concern | Detail |
|---|---|
| `ToolRegistry` | Name-keyed map. Duplicate names throw immediately. `getDefinitions()` advertises only server-executable registrations whose `advertise !== false`. |
| `ToolExecutor` | Dispatches `ToolCallInput` to registered handlers with timeout, abort, sequential execution, and capability-gated context injection. |
| `ToolRegistration` | `source: "core" | "spawn" | "skill"`, `definition`, `execution`, optional `timeoutMs`, `sequential`, `advertise`, one privileged `capability`, and optional `formatExecutionError` when a tool owns its model-facing error protocol. |
| Core handlers | The strict `work` command union, the single `write` document definition, and other definitions live in `tools/core-tools.ts`; composition wires their handlers through `lib/wired-core-tools.ts`. |
| Skills | References are retained at binding. `createSkillToolRegistrations` registers the `skill` tool (`source: "skill"`); invoke loads a SKILL.md body only when the slug is in Agent `skills.available` and `model-invocable` is not false. No legacy `invoke` registration or mutable skill catalog participates in preparation. |
| Spawn tools | `tools/spawn-tools.ts` registers `spawn`, `thread_message`, `return_result`, and `thread_report` with explicit privileged capabilities. `thread_message` `{ ref, message, mode }` puts a message into a thread (default `mode: background`); foreground targets a subagent in the caller's subtree and returns its report. `return_result` accepts Meridian document URI strings and validates them through the contracts capture schema before mapping them to `{ type: "object", uri }`. Invalid input returns a model-correctable tool error instead of aborting the child run. Neither spawn nor thread_message accepts an escalation patch. |
| Inspection tools | `tools/inspection-tools.ts` registers `thread_ls` and `thread_history` with repository and tokenizer ports at composition (`thread_report` registers with the spawn tools); see [history tools](history-tools.md). |
| Document text | `tools/document-text.ts` and `tools/history-previews.ts`: each registration owns its `DocumentTextPolicy` and `historyPreview`; see [document text in history](document-text.md). |

Handler-owned `{ isError: true, output }` results already define their
model-facing protocol, so the executor preserves their output by definition.
Parse, timeout, abort, and thrown failures belong to the executor; it delegates
those to the registration's `formatExecutionError` when present and otherwise
uses the generic Meridian error format. The canonical `write` registration owns such a
formatter so every executor-owned document failure still returns
`meridian.agent-edit.v1` without teaching the generic executor about agent-edit.

The core-tool publication boundary lives in `tools/core-tools.ts`: definitions,
names, and constraints are canonical there, but `createCoreToolRegistrations()`
requires handlers for every core tool. The composition root supplies executable
behavior; schema-only stubs are not advertised.

## Permissions

`loop/permissions/`: `projectToolPolicy` projects compiled Mars `tools` / `disallowed-tools` onto Flow tool names and command sets (`write`, `work`). `write` is always advertised with `read` and `diff`; existing `edit` policy adds or removes mutation commands. `advertiseTools` uses that same command set to narrow the schema, including its per-command descriptions, so denied-command instructions are not exposed. Retained historical `read` policy metadata is inert. `commandSetForTool` is the single command mapping. Advertise and the per-turn permission gate (name + command) use that policy. `invocation-authority` validates that an invocation patch never grants the child more than the caller holds, applied only to the patch delta. Dispatch does not apply policy. The core catalogue stays policy-free.

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
- The single document tool is `write` and every call requires an explicit
  `command`. Baseline `write({ command: "read", path: "..." })` reads and
  `write({ command: "diff" })` inspects the folded turn trail; these baseline
  commands do not expand URI, object, Project, owner, or document authorization.
  Diff additionally requires an owned Work draft, including the No Work row
  when draft mode is active; otherwise it returns `work_required`. Neither
  command changes Work binding or write mode.
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
