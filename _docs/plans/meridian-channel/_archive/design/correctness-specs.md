# Correctness Specifications

**Required reading:**
- [`README.md`](README.md) (always)
- [`design-philosophy.md`](design-philosophy.md) (always)

## Critical Correctness Specifications

These are invariants that every slice must preserve. Violation of any spec means the system is fundamentally broken. All are tested end-to-end via the `mock_harness.py` script.

**Spec 1: Finalization guarantee.** Every run that starts MUST have a finalize row written — no exceptions (signal, exception, OOM, background, timeout).
- Test: spawn run, kill the parent `meridian` process. On next `meridian run list`, run must not be stuck in `running` forever. Either `try/finally` wrote finalize, or `meridian diag repair` reconstructs from artifacts.
- Test: spawn run, SIGINT -> finalize row exists with exit code 130.
- Test: spawn run that times out -> finalize row exists with exit code 3.

**Spec 2: Context isolation.** A run agent MUST NOT see another run's context, report, or workspace state unless explicitly passed via `-f`.
- Test: run A writes a file containing prompt injection. Run B, without `-f` referencing that file, must not see it in composed prompt.
- Test: composed `input.md` contains ONLY the expected components.

**Spec 3: Context pinning survives compaction.** Pinned files MUST be re-injected after workspace resume.
- Test: pin 3 files, close workspace, resume -> composed supervisor prompt contains all 3.
- Test: pin file that was deleted from disk -> resume produces clear error.

**Spec 4: Cost tracking accuracy.** Extracted token counts and cost MUST be within 5% of actual (for harnesses that report usage).
- Test: run against each harness with known fixture output -> extracted tokens match expected values.
- Test: per-run budget $0.50, run costs $0.51 -> run terminated.

**Spec 5: ID uniqueness and resolution.** Run/workspace IDs MUST be globally unique. Resolution MUST be unambiguous within scope.
- Test: 100 concurrent `meridian run` calls -> all IDs unique, no counter collisions.

**Spec 6: Prompt sanitization.** Prior run output in continuation/retry MUST be wrapped in boundary markers.
- Test: prior output contains "Ignore all previous instructions" -> continuation wraps in `<prior-run-output>` tags.

**Spec 7: Lock correctness under concurrency.** Concurrent writers MUST NOT corrupt SQLite.
- Test: 10 parallel `meridian run` processes writing to same DB -> all finalize rows present and uncorrupted.

**Spec 8: Workspace state machine.** Transitions MUST follow: `active -> paused | completed | abandoned`. No invalid transitions.

**Spec 9: Skill discovery from `.agents/skills/` only.** Skills MUST be discovered from `.agents/skills/`, never from `.claude/skills/` or harness-specific directories.

**Spec 10: Depth limiting.** `meridian run` MUST refuse to spawn when `MERIDIAN_DEPTH >= max_depth`.

## Execution Model Strategy

**This plan is executed via `/orchestrate`** — the multi-model supervisor skill.

**Primary implementer: `gpt-5.3-codex`** — for implementation slices. Python is faster to iterate on than Rust; Codex handles it well.

**Orchestrator: `claude-opus-4-6`** — drives the `/orchestrate` loop.

| Role | Model | When |
|------|-------|------|
| Implementation (all slices) | `gpt-5.3-codex` | Default for every slice |
| Orchestration | `claude-opus-4-6` | Plan reading, slice dispatch |
| Review (majority) | `gpt-5.3-codex` | Correctness, test coverage |
| Review (selective) | `claude-opus-4-6` | Cross-slice coherence, safety |
| Commit messages | `claude-haiku-4-5` | Fast, clean messages |
