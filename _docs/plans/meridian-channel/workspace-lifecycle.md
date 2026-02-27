# Workspace Lifecycle — Hooks, Sessions, Compaction

**Status:** draft

Addresses workspace gaps 1-3 and 5. These are feature gaps (not bugs) — they add proper lifecycle management to the workspace system.

---

## 1. Hook handlers in Python (`meridian hooks` command group)

**Problem:** Hook logic lives in shell scripts (orchestrate plugin). Meridian-channel should own its own hook handlers.

**Design:** `.claude/settings.json` calls `uv run meridian hooks <event>`, all logic lives in Python.

**Hook protocol:** Read JSON from stdin (session_id, source, cwd, transcript_path), write JSON to stdout (`{"additionalContext": "..."}` or `{}`).

**Subcommands:**

| Command | Trigger | Responsibility |
|---------|---------|---------------|
| `session-track` | `SessionStart` (all), `SessionEnd` | Write session ID to workspace session log |
| `context-reinject` | `SessionStart` (compact, clear) | Re-inject skills + pinned files |

**Requires:** `MERIDIAN_RUN_ID` env var set on all runs (supervisor + child). Currently not set.

**Files to create:**
- `src/meridian/cli/hooks.py` — CLI command group
- `src/meridian/lib/ops/hooks.py` — hook handler logic

**Codex limitation:** No hooks support, so skills/pinned files can't be re-injected after compaction on Codex runs.

---

## 2. Explicit session tracking on resume

**Problem:** `workspace resume` doesn't pass explicit session ID. The `supervisor_harness_session_id` column exists but is never populated.

**Fix:** Hook handler (#1) writes session events to `.meridian/active-workspaces/<workspace_id>.sessions.jsonl`. Then:
- `meridian workspace resume` reads latest session ID from log
- Passes harness-specific continue flag: `--continue <id>` (Claude), `codex exec resume <id>` (Codex)
- Each adapter needs `continue_flags(session_id: str) -> list[str]`
- New commands: `meridian workspace sessions`, `meridian workspace resume --session <id>`

**Depends on:** #1

---

## 3. Compaction re-injection

**Problem:** When harness compacts, skill instructions and pinned files get lossy-compressed.

**Fix:** Handled by `context-reinject` hook handler (#1). On compact/clear:
1. Load active skills for workspace (from agent profile + explicit skills)
2. Load pinned files via context system
3. Return `{"additionalContext": "<skills + pinned files>"}`

**Depends on:** #1

---

## 5. Workspace summary re-generated on every resume

**Problem:** `workspace resume` calls `generate_workspace_summary()` every time, even on non-fresh resume where it's not injected.

**Investigate:** Is summary generation cheap enough to ignore? Or skip on non-fresh resume?

---

## 6. Workspace-scoped agent profiles

**Problem:** Agent profiles are either hardcoded builtins or repo-level `.agents/agents/*.md` files. A supervisor can't create ad-hoc agents during a session — e.g., "I keep needing a security-focused reviewer, let me define one."

**Design:** Workspace agents are normal `.md` profile files stored under the workspace directory:

```
.meridian/workspace/<workspace-id>/agents/security-reviewer.md
```

SQLite indexes them (name, workspace_id, created_at). Resolution order:
1. Workspace agents — `.meridian/workspace/<id>/agents/`
2. User's repo — `.agents/agents/`
3. Meridian defaults — `src/meridian/resources/.agents/agents/`

**Commands:**
- `meridian agent create <name> --model X --skills S` — writes `.md` file + indexes
- `meridian agent list` — shows all available (workspace + repo + builtin)
- `meridian agent show <name>` — displays profile details
- `meridian agent promote <name>` — copies workspace agent to `.agents/agents/` for permanent use

**Lifecycle:** Workspace agents persist for the workspace lifetime. When workspace closes, they stay on disk (can be cleaned up explicitly) but drop out of the resolution chain for other workspaces.

**Files:**
- `src/meridian/cli/agent.py` — CLI command group
- `src/meridian/lib/ops/agent.py` — agent CRUD operations
- Update `lib/config/agent.py` resolution to check workspace path first

---

## Implementation order

1. Hook command group + session-track handler (#1 core)
2. Session log reading + explicit resume (#2)
3. Context-reinject handler (#1 + #3)
4. Workspace-scoped agent profiles (#6)
5. Summary optimization (#5 — investigate first)
