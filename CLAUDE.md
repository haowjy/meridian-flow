@AGENTS.md

## Claude-specific

Delegate through `meridian spawn` fan-outs, not the built-in Agent/Task
tool, unless the user specifically asks for Claude subagents or the agent
exists only as a Claude subagent (e.g. `frontend-coder`). Meridian spawns
route to the right model and harness and leave inspectable artifacts.
