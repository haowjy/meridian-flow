@AGENTS.md

## Claude-specific

Delegate with `meridian spawn -a <agent>` and take the profile's model. Profiles
pinned to a Claude model are copied into `.claude/agents/`, because Meridian
does not run Claude headless; run those with the built-in Agent tool. Never use
the generic `claude` agent type or a fork of yourself.

Anything a writer sees (components, layout, styling, rendering behavior) is
implemented by `frontend-coder`, whoever is leading the work.
