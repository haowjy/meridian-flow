# Design Philosophy

**Required reading:**
- [`README.md`](README.md) (always)

## P1: The LLM supervisor is the brain. The CLI/MCP server is its infrastructure.

The orchestrator works like a human project lead — it reads the situation, picks the next action, evaluates results, and adapts. This is the core loop and it must stay dynamic, not be replaced by a declarative DAG scheduler.

What the Python CLI/MCP server provides is better **infrastructure** for that supervisor:
- **Better memory** — SQLite state, event logs, checkpoint/resume so the supervisor doesn't lose context
- **Better eyes** — trace spans, cost tracking, run summaries so the supervisor can see what happened
- **Safety rails** — cost budgets, permission tiers, guardrails that constrain the supervisor without replacing its judgment
- **Native tool access** — MCP tools that agents call directly, no shell spawning for tool invocation
- **Proper CLI** — `meridian run` from anywhere, not `../run-agent/scripts/run-agent.sh`

What we explicitly **do NOT build**: declarative workflow DAGs, static task graphs, or any system that removes the LLM's dynamic decision-making. The supervisor decides what to do next based on judgment, not a pre-defined graph.

## P2: Context management is the name of the game

Every design decision flows from one question: **does this help the LLM supervisor manage its context better?**

LLM agents have finite context windows. The orchestrator's job is to keep the right information accessible and the noise out:
- **Space state** should be queryable, not buried in raw logs — so the supervisor can ask "what have I done?" cheaply
- **Reports and plans** should be markdown files the supervisor can read directly — not opaque database blobs
- **Outputs** should be concise and token-efficient — every extra line costs input tokens on the next turn
- **Run history** should be filterable/summarizable — so the supervisor loads only what's relevant

**Informed by Manus AI's context engineering:**
- **Context reduction** — run results have "full" and "compact" representations; stale results get compacted
- **Context offloading** — filesystem as unlimited external memory; the supervisor uses `meridian list`/`meridian show` or MCP tools to load only what's relevant
- **Context isolation** — each run agent gets only what's explicitly passed to it, not the full space state
- **Attention management** — pinned context files are re-injected after compaction to keep key information in the model's recent attention span, but meridian manages this as infrastructure (not as an LLM action loop that wastes tokens — Manus found ~33% of actions wasted on todo.md bookkeeping)

This principle also drives the markdown-first artifact strategy (P4) and the output style guidelines (P3).

## P3: LLM-recognizable CLI, token-efficient output

The CLI's primary consumer is an LLM, not a human. The MCP server is the primary agent interface. Design accordingly.

See [cli-contract.md](cli-contract.md) for the full command grammar and output specifications.

**Token-efficient output by default:**
- Default output is **compact** — one line per run, no decorations, no box-drawing
- `--format json` for machine parsing — **stable schema, versioned** (separate contract from human output)
- `--verbose` / `--output wide` to opt-in to detail, never the default
- Error messages: one line with actionable fix, not stack traces
- MCP tools return structured JSON — composable in code execution loops

**Anti-patterns to avoid:**
- ASCII tables with box-drawing characters (wastes tokens, confuses tokenizers)
- Progress bars or spinners (useless for LLM consumers)
- Color codes / ANSI escapes in non-TTY mode (garbage tokens)
- Verbose "success" messages when exit code 0 is sufficient

## P4: Markdown is the memory layer

Markdown files are the primary durable memory format — not SQLite, not JSON. SQLite is the index; markdown is the content.

**Why markdown:**
- LLMs read markdown natively — no parsing, no format conversion
- Humans can review, edit, and commit markdown to git
- Markdown survives tool changes — if we replace `meridian` tomorrow, the `.md` files are still useful
- Version control gives free history, diff, and collaboration

**What lives in markdown:**
- `report.md` — every run's output report (written by subagent or extracted as fallback)
- `input.md` — the composed prompt sent to the subagent
- `space-summary.md` — per-space summary updated as the space progresses (committable)
- `plan.md` / task files referenced by `--file` — the orchestrator's input context

**What lives in SQLite:**
- Run metadata (timestamps, tokens, cost, status) — queryable index
- Workflow events — space state for checkpoint/resume
- Trace spans — cost/time rollups
- Run edges — continuation/retry/review/parent-child relationships

## P5: Spaces are optional — `meridian run` works standalone

`meridian` has **two operating modes**, and the entire design must support both:

| Mode | Entry point | Space? | Use case |
|------|-------------|----------|----------|
| **Space-bound** | `meridian start` / `meridian resume` | Yes — `MERIDIAN_WORKSPACE_ID` set in process tree | Multi-run orchestration, supervisor-driven workflows |
| **Standalone** | `meridian run` directly | No — no space, no env var | Quick one-off runs, `/run-agent` skill usage, CI pipelines |

**Standalone mode is the simpler path.** Someone installs `meridian`, runs `meridian run -m claude-sonnet-4-6 -p "review this"`, and it just works. No space ceremony. Runs are still logged to SQLite, still get counter IDs, still write artifacts — they just aren't scoped to a space.

**Space-bound mode adds the space lifecycle on top.** `meridian start` creates a space, launches the harness, sets `MERIDIAN_WORKSPACE_ID` in the child process tree, and `meridian run` calls within that tree auto-attach to the space transparently.

**Design implications — every feature must work in both modes:**
- `meridian run list` shows all runs (space-bound and standalone). Filter with `--space w3` or `--no-space`
- `meridian run show r7` works whether r7 belongs to a space or not
- Run counters: space-bound runs use space-scoped counters (`w3/r1`). Standalone runs use a global counter (`r1`, `r2`, `r3`)
- Directory layout: space-bound -> `.meridian/spaces/w3/runs/r1/`. Standalone -> `.meridian/runs/r1/`
- MCP tools inherit space context from the server's environment

This is critical for the **`/run-agent` skill use case** — someone loading the skill in Claude Code or Codex just wants `meridian run`. They shouldn't need to understand spaces.

### Space model (space-bound mode)

A **space** is **meridian's unit of orchestrated work** — one task from start to finish, potentially spanning many runs across different models and harnesses, and surviving context compactions, conversation clears, and harness restarts.

**Two types of conversations within a space:**

| Type | Interactive? | Purpose | Examples |
|------|-------------|---------|---------|
| **Orchestrate reader** | Yes (human-interactive) | Supervisory. Manages the big picture, decides what to do next, curates context | The main Claude Code session launched by `meridian start` |
| **Run agent** | No (autonomous) | Task-focused. Accomplishes a specific task, returns a report | `meridian run -m gpt-5.3-codex -p "research X"` |

**Flat runs with parent-child edges:**
Runs within a space are all siblings — no nested scoping. A run can spawn other runs, but they all live at the same level. Parent-child relationships are tracked in `run_edges`.

**Scoping via env vars** (follows docker DOCKER_CONTEXT, kubectl KUBECONFIG patterns):
- `MERIDIAN_WORKSPACE_ID` auto-scopes commands to the current space
- `MERIDIAN_DEPTH` tracks agent spawning depth (P9) — incremented on each `meridian run`, checked against `max_depth` (default: 3). Prevents runaway recursion.
- `--space w3` flag overrides the env var
- **Precedence:** `--space` flag > `MERIDIAN_WORKSPACE_ID` env var > error (no default guess)

**Space lifecycle — owned by `meridian`:**
```bash
meridian start                         # create w1, launch supervisor harness
meridian start --name auth-refactor    # create w2 with alias "auth-refactor"
meridian start --plan plan.md          # create w3 with a plan file
meridian resume                        # resume latest active space
meridian resume w3                     # resume specific space
meridian resume auth-refactor          # resume by alias
meridian space list                # list all spaces with status/cost
meridian space show w3             # space detail: runs, cost, pinned files
meridian space close w3            # mark as complete
meridian export --space w3         # gather committable markdown artifacts
```

**Space state machine:**
```
active -> completed    (all work done, explicit close)
active -> paused       (user exits, can resume later)
active -> abandoned    (no activity for configurable timeout)
```

## P6: Context pinning — durable context that survives compaction

Within a space, certain files are **pinned** — they persist across compaction events and are automatically re-injected into new conversations and run agents.

```bash
meridian context pin research-findings.md     # pin to space context
meridian context unpin research-findings.md   # remove from pinned
meridian context list                         # list pinned files
```

**What pinning does:**
- Pinned files are re-injected into the orchestrate reader after each compaction
- Pinned files are included in every new harness conversation started within the space
- Pinned files are passed to run agents by default (the orchestrate reader can override with explicit `-f` flags)
- The space's `space-summary.md` is always implicitly pinned

## P7: Harness abstraction — design for CLI change

The external harnesses (Claude Code, Codex, OpenCode) change their CLI flags, output formats, and features frequently. The design must be resilient to this.

**HarnessAdapter protocol** — each harness is a Protocol implementation, not an if/else branch:
```python
from typing import Protocol

class HarnessAdapter(Protocol):
    @property
    def id(self) -> HarnessId: ...

    @property
    def capabilities(self) -> HarnessCapabilities: ...

    def build_command(self, run: RunParams, perms: PermissionResolver) -> list[str]: ...

    def parse_stream_event(self, line: str) -> StreamEvent | None: ...

    def extract_usage(self, artifacts: ArtifactStore, run_id: RunId) -> TokenUsage: ...

    def extract_session_id(self, artifacts: ArtifactStore, run_id: RunId) -> str | None: ...
```

**HarnessRegistry** — harnesses registered by ID, not hardcoded:
- Built-in adapters for known harnesses (Claude, Codex, OpenCode)
- Unknown harness events are logged but don't crash parsing (forward compatibility)
- Harness CLI version tracked per run for parser routing

## P8: `meridian` owns skill discovery — progressive disclosure, no context rot

Harnesses (Claude Code, Codex) should **never** discover skills directly from `.claude/skills/` or similar directories. If 15 skills are auto-loaded into every conversation, that's 15 skill descriptions eating tokens whether relevant or not — context rot.

**`meridian` is the skill registry.** Skills live in `.agents/skills/` (the canonical, harness-agnostic location) and are indexed in SQLite. In MCP mode, the agent discovers skills via `skills.search` and `skills.load` tool calls — no prompt injection needed.

**Progressive disclosure:**
- **By default**, `meridian run` injects only the appropriate base skills (see P9)
- **On request**, the supervisor discovers skills via `meridian skills search <query>` or MCP `skills.search` tool
- **MCP advantage**: skill content is loaded on-demand via tool calls, never pre-injected into context

## P9: Three base skills — layered, independent

| Skill | Injected when | Teaches | Independence |
|-------|--------------|---------|-------------|
| **`run-agent`** | Every `meridian run` | How to use `meridian run` CLI and MCP tools (`run_create`, `run_show`, `run_wait`). Pass files with `-f`, read reports. | **Fully standalone.** |
| **`agent`** | Every `meridian run` (on top of `run-agent`) | How to be a good worker agent. Write concise reports, use `skills_search`/`skills_load` MCP tools, manage context budget. | **Needs `run-agent`.** |
| **`orchestrate`** | `meridian space start` only (supervisor) | How to manage a multi-run workflow. Use `space_*`, `context_*` MCP tools. Read plans, decompose into slices, pick models, dispatch runs. | **Needs `run-agent` + `agent`.** |

**Depth limiting prevents runaway spawning:**
```bash
# Supervisor launches at depth 0 (default)
meridian run -p "Implement auth"          # MERIDIAN_DEPTH=0 in env
# If that agent spawns a sub-agent:
meridian run -p "Research JWT libraries"  # MERIDIAN_DEPTH=1 inherited + incremented
# At max depth (default: 3), meridian refuses to spawn
# Error: "Max agent depth (3) reached. Complete this task directly."
```

## P10: To the worker agent, the orchestrator is the user

Run agents don't know they're talking to another LLM. The composed prompt must read like it came from a human.

## P11: Model catalog — user-configurable, budget-aware

`meridian models list` shows available models with short guidance. The default catalog ships with `meridian`; users override via `.meridian/models.toml`.

**Default model catalog:**

| Model | Alias | Role | Strengths | Cost |
|-------|-------|------|-----------|------|
| `claude-opus-4-6` | opus | **Default / all-rounder** | Best supervisor brain | $$$ |
| `gpt-5.3-codex` | codex | **Executor / correctness** | Repo implementation, correctness passes | $ |
| `claude-sonnet-4-6` | sonnet | **Fast generalist** | UI iteration, fast implementation | $$ |
| `claude-haiku-4-5` | haiku | **Quick transforms** | Commit messages, quick transforms | $ |
| `gpt-5.2-high` | gpt52h | **Escalation solver** | Strong generalist reasoning + coding | $$ |
| `gemini-3.1-pro` | gemini | **Researcher / multimodal** | Knowledge breadth, multimodal | $$ |

User override via `.meridian/models.toml` (same TOML format as Rust plan).

## P12: MCP-first — agents interact through tools, not CLI output parsing

**This is the key architectural difference from the Rust plan.** The primary agent interface is MCP (Model Context Protocol), not CLI stdout parsing.

**Why MCP-first:**
- Agents call structured tools, not `subprocess.run("meridian run list --format json")`
- Tool responses are typed JSON — no parsing, no format versioning headaches
- Progressive disclosure is native — agents call `skills.search()` to discover capabilities
- Composable in programmatic tool calling loops (Anthropic's `code_execution` + `allowed_callers`)
- **DirectAdapter**: meridian's operations are also exposed as Anthropic API tool definitions with `allowed_callers: ["code_execution_20260120"]`, enabling Claude to call them programmatically inside a code execution sandbox — tool results don't enter context, only final output does
- Future: `meridian` becomes an MCP multiplexer, routing tool calls to registered external MCP servers

**`meridian serve`** starts an MCP server on stdio (the standard MCP transport):
```bash
meridian serve   # MCP server mode — primary agent interface
```

The MCP server exposes the same operations as the CLI, but as structured tool calls with typed inputs and outputs. The CLI remains for human use and as a secondary agent interface.

## `meridian` vs `meridian.lib` Boundary (SRP + DIP)

All business logic lives in `meridian/lib/`. The CLI, MCP server, and DirectAdapter are **thin dispatchers**:
- `meridian/cli/` — parse CLI args via cyclopts, call `meridian.lib` functions, format output via `rich` (TTY) or plain/JSON
- `meridian/server/` — MCP tool handlers, call `meridian.lib` functions, return structured JSON
- `meridian/lib/harness/direct.py` — generates Anthropic API tool definitions from registry, handles tool-calling loop
- `meridian/lib/` — all domain logic: state, config, prompt, exec, extract, safety
- `meridian/lib/ops/` — **Operation Registry** — defines each operation once, auto-exposes to all three surfaces

**Rule:** If a CLI command or MCP handler grows beyond arg parsing + output formatting, the logic belongs in `meridian.lib`.

**`meridian.lib` public API** (explicitly defined — not a grab bag):
```python
# meridian/lib/__init__.py — public surface
from meridian.lib.ops.registry import get_all_operations, get_operation
from meridian.lib.ops.run import run_create, run_list, run_show, run_continue, run_retry
from meridian.lib.ops.skills import skills_search, skills_load, skills_list, skills_reindex
from meridian.lib.ops.models import models_list, models_show
from meridian.lib.ops.space import space_start, space_resume, space_list, space_show, space_close
from meridian.lib.ops.context import context_pin, context_unpin, context_list
from meridian.lib.ops.diag import diag_doctor, diag_repair
```
