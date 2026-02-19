---
name: model-guidance
description: Model tendencies and selection guidance for the orchestrator
---

# Model Guidance

Reference for choosing the right agent variant. Used by the orchestrate skill when deciding which agent to launch.

## Model Tendencies

| Model | Strengths | Weaknesses | Best For |
|---|---|---|---|
| **gpt-5.3-codex** | Deep, exhaustive code generation; strong at multi-file changes; thorough verification | Slower; higher cost | Default implementation, review, planning |
| **claude-sonnet-4-6** | Fast iteration; good UI intuition; strong at incremental changes | Less exhaustive on large refactors | UI loops, rapid iteration, frontend tweaks |
| **claude-opus-4-6** | Deep reasoning; careful architectural decisions; nuanced trade-offs | Slower than Sonnet; higher cost | Complex logic, architectural changes, subtle bugs |
| **claude-haiku-4-5** | Very fast; low cost; good at straightforward tasks | Limited depth on complex reasoning | Commit messages, simple transformations |

## Agent Variant Selection

### `implement` (gpt-5.3-codex)
**Default choice.** Use for most slices — especially cross-stack changes, new features, and backend work. Exhaustive and thorough.

### `implement-iterative` (claude-sonnet-4-6)
Use when:
- Doing rapid UI iteration (tweak -> check -> tweak)
- Frontend-only changes with quick feedback loops
- The slice is well-defined and doesn't need deep exploration

### `implement-deliberate` (claude-opus-4-6)
Use when:
- The slice involves subtle correctness concerns (race conditions, state machines)
- Architectural decisions need careful reasoning
- Previous implementation attempts failed or produced bugs

### General Rules

1. **Start with `implement`** (default) unless you have a specific reason to use a variant.
2. **Switch to `implement-iterative`** if the slice is UI-focused and you want faster cycles.
3. **Escalate to `implement-deliberate`** if a slice fails on the first attempt or involves tricky logic.
4. **Use `-m MODEL` override** on any agent when you want to temporarily switch models without changing the agent definition.
