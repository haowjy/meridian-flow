# Orchestrate Loop Improvements

**Status:** draft

Lessons learned from running a 4-cycle orchestrate session (DX improvements) using the current `run-agent.sh` + shell orchestration. This plan captures friction points and patterns to inform meridian's own orchestration capabilities.

---

## Context

The orchestrate session executed 4 implement→review→rework→commit cycles across 6 DX items. ~17 runs total (4 implement, ~9 reviews, ~4 reworks, manual fixes). All runs were launched in background. Session duration: ~2.5 hours.

The orchestrate skill works, but relies on shell scripting patterns (`&`, `wait`, `PID=$!`, `ls | sort | tail`) that are fragile and verbose. Meridian should internalize these patterns as first-class features.

---

## OL-1: First-class fan-out (HIGH)

**Problem:** Parallel reviewer fan-out required shell `&` + `wait` which failed silently (2/3 reviewers got exit 127 in Cycle 1 due to path resolution). The workaround (explicit `PID=$!` + `wait $PID1 $PID2`) is verbose and error-prone.

**What worked:** When parallel runs did execute, they found non-overlapping issues even from the same model with different prompts.

**Design direction:** `meridian run create -m codex,codex,opus` or a dedicated fan-out mode. Returns all run IDs. Blocking mode waits for all. Already captured as DX-12 but this is the #1 usability gap.

**Key question:** Should fan-out be purely model-based (`-m a,b,c`) or also support same-model-different-prompt (e.g., reviewer focus areas)?

---

## OL-2: Run progress visibility (HIGH)

**Problem:** After launching a background run, zero visibility into progress. For a 5-min codex run this is fine. For a 15-min opus run that ultimately timed out, it was wasted time with no signal.

**What would help:**
- Elapsed time indicator
- Token count / cost so far
- Last tool call or activity summary
- "Still running" heartbeat

**Design question:** Is this a meridian concern (run progress API) or a harness concern (transcript streaming)? Probably both — meridian tracks the run, harness provides the stream.

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

**Design question:** Should sessions be explicit (`--session ID`) or implicit (all runs in a workspace session are grouped)?

---

## OL-4: Report retrieval by run ID (HIGH)

**Problem:** After every run, had to `ls .orchestrate/runs/agent-runs/ | sort | tail` then `cat .../report.md`. Verbose and error-prone with parallel runs.

**Already captured as DX-10.** Key insight from real usage: `@latest` is fine for sequential workflows but useless when 3 reviewers finish in parallel. Explicit run IDs are the primary interface.

**Pattern that worked:** The run-agent.sh output includes the run directory path. Capturing that and using it directly was the most reliable approach.

---

## OL-5: Reviewer templates / structured review prompts (MEDIUM)

**Problem:** Every review launch required writing a long `-p` string: "Review X. Focus on: 1) ... 2) ... 3) ...". Same structure every time, just different focus areas.

**What would help:** A reviewer agent profile that accepts structured input:
```bash
meridian run create --agent reviewer -m codex \
  --var FOCUS="resolution order, error handling, test coverage" \
  --var CONTEXT="DX-11 self-containment" \
  -f plan.md
```

The reviewer profile template would compose the prompt from these variables.

**Design question:** Is this just template variables in agent profiles (already supported?) or does it need a richer input contract?

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

**Design question:** Should meridian have a `meridian task create` that scaffolds a task file from a plan? The `plan-task` skill already does this — maybe it should output to a standard location that `run create` knows about.

---

## OL-8: Implement→Review→Rework loop as a workflow (MEDIUM)

**Problem:** The full loop (implement → fan-out review → evaluate → rework if needed → review again → commit) is the right pattern but I had to orchestrate it manually every cycle. Same structure, different content.

**What would help:** A composable workflow:
```bash
meridian workflow run implement-review-commit \
  --task plan.md \
  --implement-model codex \
  --review-models codex,codex \
  --rework-model codex
```

**Design question:** Is this too opinionated? The orchestrate skill is meant to be the flexible supervisor. Maybe workflows are just documented patterns in the supervisor's prompt, not hard-coded CLI features. The philosophy is "let agents be themselves" — a rigid workflow might fight that.

---

## OL-9: Model selection validated by real usage (LOW)

**Confirmed from this session:**
- **Codex for implementation:** Fast (3-5 min), reliable, good quality. Right default.
- **Codex for review:** Fast (2-4 min), thorough when given focus areas. Good default for medium risk.
- **Opus for architecture:** Thorough but slow (timed out at 15 min). Better as reviewer than implementer for complex tasks.
- **Multiple same-model reviewers with different prompts:** Effective — found non-overlapping issues. Prompt diversity > model diversity for review.
- **Haiku for commits:** Not tested this session (committed directly). Should test next time.

**Update model guidance** with these real-world timings and patterns.

---

## Implementation Priority

1. **OL-1** (fan-out) + **OL-4** (report retrieval) — highest friction, already in DX plan
2. **OL-2** (progress) + **OL-3** (session stats) — visibility gaps
3. **OL-5** (reviewer templates) + **OL-6** (per-run timeout) — polish
4. **OL-7** (task files) + **OL-8** (workflows) — need design discussion
5. **OL-9** (model guidance) — update docs with real data

## Open Design Questions

1. Should the orchestrate loop be a meridian-native workflow or remain a supervisor-driven pattern?
2. Fan-out: model-based only or also prompt-based (same model, different focus)?
3. Sessions: explicit labeling or implicit workspace grouping?
4. Progress: meridian-level polling or harness-level streaming?
5. How much structure should meridian impose vs leaving to the supervisor agent?
