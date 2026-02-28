# Orchestrate Loop Improvements

**Status:** in-progress

Lessons learned from running a 4-cycle orchestrate session (DX improvements) using the current `run-agent.sh` + shell orchestration. This plan captures friction points and design decisions to inform meridian's own orchestration capabilities.

---

## Context

The orchestrate session executed 4 implement→review→rework→commit cycles across 6 DX items. ~17 runs total (4 implement, ~9 reviews, ~4 reworks, manual fixes). All runs were launched in background. Session duration: ~2.5 hours.

The orchestrate skill works, but relies on shell scripting patterns (`&`, `wait`, `PID=$!`, `ls | sort | tail`) that are fragile and verbose. Meridian should internalize these patterns as first-class features.

---

## OL-1: One run per invocation + `run wait` (HIGH)

**Problem:** Parallel reviewer fan-out required shell `&` + `wait` which failed silently (2/3 reviewers got exit 127 in Cycle 1 due to path resolution).

**What worked:** When parallel runs did execute, they found non-overlapping issues even from the same model with different prompts. Prompt diversity > model diversity for review.

**Design decision: no fan-out flag. Just call `meridian run create` multiple times.**

`run create` is **non-blocking** — it submits the run, prints the run ID, and returns immediately. The caller composes parallelism however they want.

```bash
R1=$(meridian run create --agent reviewer -m codex \
  -f @review-prompt -f @diff --var FOCUS=packaging --var DEPTH=surface)

R2=$(meridian run create --agent reviewer -m opus \
  -f @review-prompt -f @diff --var FOCUS=architecture --var DEPTH=deep)

R3=$(meridian run create --agent reviewer -m codex \
  -f @review-prompt -f @diff --var FOCUS=tests --var DEPTH=surface)

meridian run wait $R1 $R2 $R3
```

The heavy context is in files (`-f`). The prompt/command is short. Repeating the command is trivial for a supervisor LLM. No `--run`, `--fan-out`, `--matrix`, `--models`, `--each` flags needed. Meridian runs one thing well per invocation.

**`meridian run wait`** collects results from multiple parallel runs:
- Blocks until all specified runs complete
- Prints summary with run IDs, exit codes, durations
- Exit code policy: non-zero if ANY run failed (like `set -e` for runs)
- Run IDs in output labels for the supervisor to map back to specific reports

**Prompt variation via `--var`, not env vars.** Template vars in context files (using `{{VAR}}` syntax) are expanded during prompt composition:

```bash
meridian run create --agent reviewer -m codex \
  -f @review-prompt --var FOCUS=packaging --var DEPTH=surface
```

`--var` is better than env vars because:
- **Scoped** — only applied to file/prompt composition, not leaked to child processes
- **Logged** — meridian records what vars were used per run in the artifact
- **No collision risk** — env vars like `FOCUS` are generic and could clash; `--var` is namespaced to the run

Note: defer `--var` validation (warning on unused/unresolved vars) to a later lint pass. Static scanning of files for `{{VAR}}` references has edge cases (code blocks, generated content). Don't attempt in v1.

**Rejected alternatives:**
- `--run` bundles (model+vars tuples) — prompt deduplication solved by context files; just repeat the short command
- `--models codex,opus` (sugar) — unnecessary abstraction
- `--each VAR=a,b` — unnecessary abstraction
- `--matrix` (cartesian product) — wrong model, gives unwanted combinations
- `--fan-out` flag — infrastructure jargon
- Env vars for template expansion — leaking risk, collision risk, invisible/hard to debug
- `$VAR` template syntax — collides with shell variables; use `{{VAR}}` instead
- `--run-file reviews.yaml` — premature; revisit if real usage demands it

Research: "matrix" dominates CI (GitHub Actions, GitLab), "each/loop/for" dominates infra (Terraform, Ansible). Neither fits. No LLM CLI has fan-out primitives yet. Keeping it simple with repeated invocations is the right starting point.

---

## OL-2: Run progress visibility (HIGH)

**Problem:** After launching a background run, zero visibility into progress. For a 5-min codex run this is fine. For a 15-min opus run that ultimately timed out, it was wasted time with no signal.

**Design decision: layered extraction via harness adapters.**

Two consumers of output, two formats:

| Consumer | Format |
|---|---|
| Human at TTY | Live-updating display, colors, progress |
| LLM via pipe | Append-only events, no rewrites (detected via `isatty()`) |

**Pipe/LLM output** (append-only, no ANSI rewrites):

```
[codex/packaging]    started
[opus/architecture]  started
[codex/tests]        done (38s) exit=0
[codex/packaging]    done (45s) exit=0
[opus/architecture]  done (62s) exit=0
```

**Extraction is adapter-specific, tuned not configurable.** Each harness adapter knows its own output conventions:

```python
class HarnessAdapter(Protocol):
    EVENT_CATEGORY_MAP: dict          # existing
    def extract_tasks(self, event) -> list[Task] | None: ...
    def extract_findings(self, event) -> list[Finding] | None: ...
    def extract_summary(self, output) -> str | None: ...
```

- Claude adapter knows about TodoWrite events
- Codex adapter knows about its task format
- Generic adapter returns None → lifecycle events only

The CLI doesn't hardcode what to parse — it asks the adapter. Extraction list is an internal implementation detail, not a user-facing knob. We tune what each adapter extracts.

**CLI output levels:**

| Flag | Controls |
|---|---|
| `--verbose` / `--quiet` | CLI output level (how much the CLI tells you — confirmations, progress, summaries) |
| `--debug` | Internal diagnostics (prompt composition, harness commands, path resolution, raw agent stream) |

Agent stream filtering (which event categories to show) is an internal implementation detail driven by the output level, not a separate user-facing axis. No `--agent-verbosity` flag. Keep the CLI surface minimal.

**Already implemented:** Stream event parsing with semantic categories, report extraction, files-touched extraction, terminal filtering with category-based presets, depth-aware formatting. What's missing: task/todo extraction, tagged section parsing — but the adapter architecture is ready for it.

---

## OL-3: Session summary and stats (HIGH)

**Problem:** No way to see aggregate session state. Had to manually reconstruct what happened across 4 cycles. The task list (TaskCreate/TaskUpdate) helped but it's a separate system.

**What would help:**
```
meridian run stats --session $SESSION_ID
Session: 20260227T054627Z-784273
Runs: 17 total (13 passed, 1 failed, 3 in-progress)
Duration: 2h 34m
Models: codex (14), opus (3)
Cost: ~$X.XX
```

**Design decision: explicit sessions.** `MERIDIAN_SESSION` is already threaded through the design (OL-5). Sessions are explicit — you create one, pass the ID, and all runs tagged with that session are grouped. No implicit grouping magic.

Note: OL-5 (session scoping) must be implemented before this item — OL-3 depends on the session concept OL-5 defines.

---

## OL-4: Report retrieval by run ID (HIGH)

**Problem:** After every run, had to `ls .orchestrate/runs/agent-runs/ | sort | tail` then `cat .../report.md`. Verbose and error-prone with parallel runs.

**Already captured as DX-10.** Key insight from real usage: `@latest` is fine for sequential workflows but useless when 3 reviewers finish in parallel. Explicit run IDs are the primary interface.

**Pattern that worked:** The run-agent.sh output includes the run directory path. Capturing that and using it directly was the most reliable approach.

---

## OL-5: Space file management with `@` references (HIGH — dependency for OL-3)

**Problem:** Agents need a place to write task files, prompts, and context. In the session, files were written ad-hoc to `.orchestrate/session/plans/`. No consistent location, no discoverability.

**Design decision: `meridian space write` with `@` sigil references.**

```bash
# Write a file to the space
meridian space write @dx-11-task < content.md

# Use it in a run via @ reference
meridian run create -f @dx-11-task -m codex

# List space contents
meridian space ls
```

**`@` sigil** distinguishes space references from file paths:
- `-f ./some/file.md` — literal file path, used directly
- `-f @dx-11-task` — space reference, meridian resolves it

**Flat namespace** to start. No nesting. Good names over directory hierarchy:
```
@dx-11-task
@dx-11-review-prompt
@dx-11-diff
```
Add single-level grouping (`@group/name`) later if space gets noisy. YAGNI until then.

**Session scoping for space isolation:**

When launched from a meridian space, files live under the space session:
```
.meridian/sessions/<session-id>/<name>.md
```

When using the CLI standalone (no space), the first `meridian space write` auto-generates a session ID and returns it:
```
$ meridian space write @dx-11-task < content.md
No active session. Created: abc123
Pass --session abc123 or set MERIDIAN_SESSION=abc123 for subsequent commands.
Written: .meridian/sessions/abc123/dx-11-task.md
```

**Session sharing model:** The supervisor creates the session and passes `MERIDIAN_SESSION` to child agents. Children inherit the session and can read/write space files within it. This is intentional — reviewers need to read `@dx-11-task` that the supervisor wrote. Parallel agents within the same session can read shared files; writes use unique names to avoid races.

**Why not auto-set in the shell?** A subprocess can't set env vars in the parent shell. The `eval $(...)` trick is fragile. Having the LLM explicitly set the env var after the first space write is simple and race-free.

**Agent profile stays static** — defines the role, not the task. Task-specific content goes in space files passed via `-f @name`.

---

## OL-6: Per-run timeout configuration (MEDIUM)

**Problem:** run-agent.sh had a hardcoded 15-min timeout. Opus timed out on an architectural task that needed deep investigation. Codex finished similar tasks in 3-5 min.

**Now 30 min** (user changed), but the right answer is per-run:
```bash
meridian run create --timeout 1800 -m opus ...  # 30 min for deep work
meridian run create --timeout 300 -m codex ...  # 5 min for quick fixes
```

Meridian already has `wait_timeout_seconds` in config — should `--timeout` on `run create` override it per-run?

---

## OL-7: Task file as first-class input (MEDIUM)

**Problem:** Writing task files to `.orchestrate/session/plans/` then passing via `-f` was the most effective prompting pattern. But it's manual — I had to `Write` the file, then pass it.

**What worked:** Structured task files with Goal, Current State, Implementation steps, Files to modify, Acceptance Criteria, Constraints. This format consistently produced good results from codex.

**Design direction:** With OL-5 space management, the flow becomes:
```bash
meridian space write @dx-11-task < content.md
meridian run create -f @dx-11-task -m codex
```

The `plan-task` skill could output directly to the space via `meridian space write`.

---

## OL-8: Implement→Review→Rework loop as a workflow (MEDIUM) ✓ DONE

**Decision:** Supervisor-driven workflow, not a CLI feature. Documented as a workflow recipe.

**Design:** See `_docs/plans/meridian-channel/ol-8-workflow-design.md` for the full recipe with Mermaid loop diagram, step-by-step bash commands, and model guidance table.

**Key decision:** No YAML recipes, no CLI command. The loop has variable structure that fights hardcoding. The recipe lives in the supervisor's prompt context. This is the right balance — more structured than pure prose, less rigid than a CLI primitive.

---

## OL-9: Model selection validated by real usage (LOW) ✓ DONE

**Confirmed from this session:**
- **Codex for implementation:** Fast (3-5 min), reliable, good quality. Right default.
- **Codex for review:** Fast (2-4 min), thorough when given focus areas. Good default for medium risk.
- **Opus for architecture:** Thorough but slow (timed out at 15 min). Better as reviewer than implementer for complex tasks.
- **Multiple same-model reviewers with different prompts:** Effective — found non-overlapping issues. Prompt diversity > model diversity for review.
- **Sonnet for focused reviews:** 3-5 min, high quality findings with good structure.
- **Haiku for commits:** Not tested this session (committed directly). Should test next time.

**Updated:** `run-agent/references/default-model-guidance.md` with real-world timings table and key findings.

---

## OL-10: Model validation and suggestions on error (LOW)

**Problem:** Running with an invalid model (e.g., `codex` instead of `gpt-5.3-codex`) fails with a cryptic harness error. No guidance on what to use instead.

**Design direction:** When `run create` gets a model rejection from the harness, suggest alternatives from the loaded model guidance:

```
Error: model 'codex' not supported by Codex CLI
Available models for Codex: gpt-5.3-codex, o4-mini, o3
Did you mean: gpt-5.3-codex?
```

Model guidance should prevent this in the supervisor case (it knows valid names), but typos, account limitations, and model deprecations happen. Graceful error with suggestions is cheap to implement and saves debugging time.

---

## OL-11: Non-blocking `run create` at CLI (HIGH — prerequisite for orchestration)

**Problem:** `run create` is blocking at the CLI level — it waits for the run to complete before returning. Non-blocking mode only exists via MCP (`run_create()` async). This means a CLI-based supervisor can't launch parallel runs without shell `&`, which is exactly the fragile pattern that broke in the orchestrate session.

**What's needed:** A `--background` flag (or similar) on `run create` that submits the run and returns the run ID immediately:

```bash
R1=$(uv run meridian run create --background -m codex -p "Review" -f @task)
# → prints run ID, returns immediately
```

**Already exists in MCP** — the async `run_create()` path returns immediately with `status: "running"`. The CLI just needs to expose this mode.

**This is the only blocker for using meridian CLI over run-agent.sh for orchestration.** Everything else (`--var`, `-f`, `-m`, `--timeout-secs`, `run wait`, `run show`) already works.

---

## OL-12: Harness session continuation and fork (MEDIUM)

**Problem:** `run continue` and `run retry` currently just call `run create` again — they don't resume the harness session or fork it. run-agent.sh has native resume/fork/in-place logic with harness session ID extraction.

In the orchestrate session, every cycle was a fresh run. But continuation is useful for iterative workflows where you want to build on prior context.

---

## OL-13: Run index feature parity with run-index.sh (MEDIUM)

**Problem:** run-index.sh has features not yet in meridian: `@latest`/`@last-failed` refs, log inspection, tool call summaries, stats, `maintain --compact`, `retry --undo-first`.

Meridian has `run show`, `run list`, `run wait` which covers the core needs. The advanced features (`@latest` refs, log inspection, stats, compact) round out the CLI.

---

## OL-14: Agent profile `skills` field semantics (MEDIUM)

**Current behavior:** `skills: [run-agent, agent]` in the agent profile auto-injects those skills' content into the prompt for every run.

**Design clarification:**
- `skills: [...]` — always injected into prompt. Defines the agent's core instructions. Keep this minimal.
- No `allowed-skills` field. The harness handles tool/skill availability natively (auto-detection, `/` commands, MCP). Meridian doesn't gate what the harness can access.
- `--skills` on the CLI always works to add additional skill content to a specific run.

Skills are just prompt content, not executable permissions. No reason to restrict reading instructions.

---

## Implementation Priority

**Migration blocker (do first):**
1. **OL-11** (non-blocking `run create`) — the only blocker for switching from run-agent.sh

**Core improvements:**
2. **OL-5** (space/sessions) — foundation for session concept, dependency for OL-3
3. **OL-1** (`run wait` spec) + **OL-4** (report retrieval) — highest friction
4. **OL-2** (progress/extraction) + **OL-3** (session stats) — visibility gaps (OL-3 depends on OL-5)

**Ergonomics:**
5. **OL-6** (per-run timeout) + **OL-7** (task files) — agent quality of life
6. **OL-14** (skills field semantics) — clarify autoload vs harness-native

**Design needed:**
7. ~~**OL-8** (workflows)~~ ✓ Done — supervisor-driven recipe, see `ol-8-workflow-design.md`

**Polish:**
8. ~~**OL-9** (model guidance)~~ ✓ Done — updated `default-model-guidance.md` with real-world timings
   **OL-10** (model validation) — incremental improvement

**Feature parity:**
9. **OL-12** (continuation/fork) + **OL-13** (run-index parity) — complete the CLI

## Resolved Design Questions

1. **No fan-out primitive.** Just call `meridian run create` multiple times. `run create` is non-blocking, returns run ID immediately. Add `meridian run wait` for collecting parallel results. (OL-1)
2. **Prompt variation via `--var` with `{{VAR}}` syntax.** Template vars in context files expanded during prompt composition. Scoped to the run, logged in artifacts. No env vars (leak/collision risk). No `$VAR` syntax (shell collision). Defer var validation to a lint pass. (OL-1)
3. **Output extraction via harness adapters.** Adapter-specific, tuned not configurable. Each adapter extracts what it knows about. Unknown harnesses get lifecycle events only. (OL-2)
4. **CLI output: `--verbose`/`--quiet` + `--debug`.** Two levels, not three axes. `--verbose`/`--quiet` controls CLI output level. `--debug` enables diagnostics including raw agent stream. No `--agent-verbosity` flag — agent stream filtering is internal, driven by output level. (OL-2)
5. **TTY vs pipe.** `isatty()` detection. TTY gets live display. Pipe gets append-only events. (OL-2)
6. **Explicit sessions.** `MERIDIAN_SESSION` env var, created on first space write if none exists. Sessions are explicit, not implicit. (OL-3, OL-5)
7. **Space files with `@` references.** `meridian space write @name`, resolved via `-f @name`. Flat namespace. `@` sigil avoids ambiguity with file paths. (OL-5)
8. **Session sharing model.** Supervisor creates session, child agents inherit via `MERIDIAN_SESSION`. Children can read shared space files. Writes use unique names to avoid races. (OL-5)
9. **Agent profiles are static roles.** No template vars in profiles. Task variation goes in `--var` and space files. (OL-5)
10. **`run wait` exit code policy.** Non-zero if any run failed. Output includes run IDs for the supervisor to map back to specific reports. (OL-1)
11. **Skills field = autoload only.** `skills: [...]` in agent profile injects into prompt. No `allowed-skills` — harness handles tool availability natively. `--skills` on CLI always works for per-run additions. (OL-14)

## Resolved Design Questions (continued)

12. **Implement→review→rework loop is supervisor-driven.** No CLI command, no YAML recipe. Documented as a workflow recipe in `ol-8-workflow-design.md`. The supervisor internalizes the pattern; the CLI stays minimal. (OL-8)
13. **Prompt diversity > model diversity for review.** Multiple same-model reviewers with different focus prompts find more non-overlapping issues than a single cross-model review. (OL-9)
14. **Opus as reviewer, not implementer, for complex tasks.** Set `--timeout-secs 1800`. Avoid using as implementer for broad tasks — too slow. (OL-9)

## Remaining Design Questions

1. Task file scaffolding: should `plan-task` output to a standard location that `run create` knows about? (OL-7)
2. How much workflow structure should meridian impose vs leaving to the supervisor agent? (resolved for loop pattern — answer is: leave to supervisor)
