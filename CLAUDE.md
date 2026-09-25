@AGENTS.md

## Claude-specific

Delegate through `meridian spawn -a <agent>` by default, and take the profile's
resolved model. Profiles set a model per task to balance cost and
effectiveness. Escalate to a defined Claude agent from `.claude/agents/`
(built-in Agent tool) only when a task is delicate enough to need a Claude
model. Never use the generic `claude` agent type or a fork of yourself.

Anything a writer sees (components, layout, styling, rendering behavior) is
implemented by `frontend-coder`, whoever is leading the work.
