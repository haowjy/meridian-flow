@AGENTS.md

## Claude-specific

Delegate through `meridian spawn` fan-outs, not the built-in Agent/Task
tool, unless the user specifically asks for Claude subagents or the agent
exists only as a Claude subagent (e.g. `frontend-coder`). Meridian spawns
route to the right model and harness and leave inspectable artifacts.

**Frontend routing (human ruling, 2026-07-25): anything a writer sees —
components, layout, styling, rendering behavior — routes to the
`frontend-coder` Claude subagent. Never send visual/frontend work to
gpt-dev/codex lanes; they optimize for "fits and passes checks," not
design fidelity. Server/domain correctness work stays with gpt-dev.**
