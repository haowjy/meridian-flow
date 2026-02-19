---
name: scratchpad
description: Conventions for scratch notes and scope-based file organization. Configurable via SCRATCHPAD_ROOT env var.
user-invocable: false
---

# Scratchpad Conventions

Scratch files and notes live under a scratchpad root directory.

**`SCRATCHPAD_ROOT`** — env var that sets the root. Default: `.data/` within this skill directory (i.e., `.agents/skills/scratchpad/.data/`).

Other skills (e.g., orchestrate) may override this with their own scope roots.

## Directory Layout

- `$SCRATCHPAD_ROOT/scratch/` — scratch notes
- `$SCRATCHPAD_ROOT/scratch/code/` — scratch code
- `$SCRATCHPAD_ROOT/logs/agent-runs/` — agent run logs

## Rules

- Prefer small dated markdown notes (e.g., `scratch/2026-02-16-topic.md`) so context survives compaction
- Do not store secrets or raw tokens in scratch files (`.env` values, JWTs, API keys, cookies)
- Keep scratch content concise and slice-focused; delete stale notes when a slice is fully complete
