# Space Lifecycle — Hooks, Sessions, Compaction

**Status:** draft

Addresses space gaps 1-3 and 5. These are feature gaps (not bugs) — they add proper lifecycle management to the space system.

---

## 1. Hook handlers in Python (`meridian hooks` command group)

**Problem:** Hook logic lives in shell scripts (orchestrate plugin). Meridian-channel should own its own hook handlers.

**Design:** `.claude/settings.json` calls `uv run meridian hooks <event>`, all logic lives in Python.

**Hook protocol:** Read JSON from stdin (session_id, source, cwd, transcript_path), write JSON to stdout (`{"additionalContext": "..."}` or `{}`).

**Subcommands:**

| Command | Trigger | Responsibility |
|---------|---------|---------------|
| `session-track` | `SessionStart` (all), `SessionEnd` | Write session ID to space session log |
| `context-reinject` | `SessionStart` (compact, clear) | Re-inject skills + pinned files |

**Requires:** `MERIDIAN_RUN_ID` env var set on all runs (supervisor + child). Currently not set.

**Files to create:**
- `src/meridian/cli/hooks.py` — CLI command group
- `src/meridian/lib/ops/hooks.py` — hook handler logic

**Codex limitation:** No hooks support, so skills/pinned files can't be re-injected after compaction on Codex runs.

---

## 2. Explicit session tracking on resume

**Problem:** `space resume` doesn't pass explicit session ID. The `supervisor_harness_session_id` column exists but is never populated.

**Fix:** Hook handler (#1) writes session events to `.meridian/active-spaces/<space_id>.sessions.jsonl`. Then:
- `meridian space resume` reads latest session ID from log
- Passes harness-specific continue flag: `--continue <id>` (Claude), `codex exec resume <id>` (Codex)
- Each adapter needs `continue_flags(session_id: str) -> list[str]`
- New commands: `meridian space sessions`, `meridian space resume --session <id>`

**Depends on:** #1

---

## 3. Compaction re-injection

**Problem:** When harness compacts, skill instructions and pinned files get lossy-compressed.

**Fix:** Handled by `context-reinject` hook handler (#1). On compact/clear:
1. Load active skills for space (from agent profile + explicit skills)
2. Load pinned files via context system
3. Return `{"additionalContext": "<skills + pinned files>"}`

**Depends on:** #1

---

## 5. Space summary re-generated on every resume

**Problem:** `space resume` calls `generate_space_summary()` every time, even on non-fresh resume where it's not injected.

**Investigate:** Is summary generation cheap enough to ignore? Or skip on non-fresh resume?

---

## 6. Space-scoped agent profiles

**Problem:** Agent profiles are either hardcoded builtins or repo-level `.agents/agents/*.md` files. A supervisor can't create ad-hoc agents during a session — e.g., "I keep needing a security-focused reviewer, let me define one."

**Design:** Space agents are normal `.md` profile files stored under the space directory:

```
.meridian/space/<space-id>/agents/security-reviewer.md
```

SQLite indexes them (name, space_id, created_at). Resolution order:
1. Space agents — `.meridian/space/<id>/agents/`
2. User's repo — `.agents/agents/`
3. Meridian defaults — `src/meridian/resources/.agents/agents/`

**Commands:**
- `meridian agent create <name> --model X --skills S` — writes `.md` file + indexes
- `meridian agent list` — shows all available (space + repo + builtin)
- `meridian agent show <name>` — displays profile details
- `meridian agent promote <name>` — copies space agent to `.agents/agents/` for permanent use

**Lifecycle:** Space agents persist for the space lifetime. When space closes, they stay on disk (can be cleaned up explicitly) but drop out of the resolution chain for other spaces.

**Files:**
- `src/meridian/cli/agent.py` — CLI command group
- `src/meridian/lib/ops/agent.py` — agent CRUD operations
- Update `lib/config/agent.py` resolution to check space path first

---

## Implementation order

1. Hook command group + session-track handler (#1 core)
2. Session log reading + explicit resume (#2)
3. Context-reinject handler (#1 + #3)
4. Space-scoped agent profiles (#6)
5. Summary optimization (#5 — investigate first)
