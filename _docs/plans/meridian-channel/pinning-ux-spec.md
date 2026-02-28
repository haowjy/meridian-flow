# Pinning and Session State Management — UX Specification

**Status:** draft
**Scope:** meridian-channel CLI
**Addresses:** Post-compaction context loss (space-gaps.md #3)

---

## Problem

When a harness compacts its conversation, skill instructions and pinned file contents get
lossy-compressed. Users running long sessions (e.g., multi-hour orchestrate loops) lose
context they explicitly set up: project rules, task files, skill instructions.

The `context-reinject` hook (space-lifecycle.md #1/#3) already handles the re-injection
mechanism — when `source: compact` fires on `SessionStart`, the hook returns
`{"additionalContext": "..."}` with the content to restore. The missing piece is the
**user-facing interface** for specifying what gets re-injected.

---

## Mental Model

**Pinned context = space-level persistent context that survives harness compaction.**

When compaction fires, the `context-reinject` hook reads the space's pin set and
re-injects those files and skills. Pinning is the interface for declaring "always keep
this in context, even after summarization."

**Scope: Space-level.** Pins persist for the space lifetime and are isolated
per space. Different spaces have independent pin sets.

### Analogies

| Tool | Analogue | Similarity |
|------|----------|------------|
| Git | `.gitattributes` | Per-project persistent file configuration |
| Claude Code | `CLAUDE.md` | Always-injected project context (but static; pinning is dynamic) |
| Tmux | `tmux.conf` | Persistent session configuration |
| Git | `git add` (staging) | Explicit opt-in before an operation |

### What Pinning Is NOT For

| Use case | Right tool |
|----------|------------|
| One-off file injection for a single run | `-f <file>` on `run create` |
| Always-on skill for all spaces | Agent profile (`skills: [...]` in `.agents/agents/*.md`) |
| Temporary context note for this session | `meridian space write @name` |
| Project-wide permanent context | `CLAUDE.md` in the repo root |

---

## Command Reference

### `meridian context` — manage pinned space context

#### File Pinning

```bash
# Pin a file (relative to space root, or absolute)
meridian context pin <file>

# Pin with a display label (used in meridian status and context-reinject header)
meridian context pin <file> --label <name>

# Unpin a file
meridian context unpin <file>
```

#### Skill Pinning

```bash
# Pin a skill to this space (re-injected after compaction)
meridian context skill add <skill>

# Unpin a skill
meridian context skill remove <skill>
```

#### Listing and Bulk Management

```bash
# List all pinned files and skills for the current space
meridian context list     # alias: meridian context ls

# Show injected content (char counts, first line preview)
meridian context list --verbose

# Remove all pins (files + skills) — fresh start
meridian context clear
```

---

### `meridian status` — full space state at a glance

```bash
meridian status
```

Covers: space identity, active session, compaction count, pinned context summary,
recent run stats. This is the "what's going on" command.

---

## CLI Mockups

### `meridian context list` (default)

```
Space: auth-refactor (ws-abc123)

Pinned files (3):
  CLAUDE.md                                          2.1k chars
  backend/CLAUDE.md                                  3.4k chars
  _docs/plans/auth-task.md           [task]          1.8k chars

Pinned skills (2):
  researching
  reviewing

Total: ~7.3k chars   re-injected on compaction
```

### `meridian context list --verbose`

```
Space: auth-refactor (ws-abc123)

Pinned files (3):

  CLAUDE.md                                          2.1k chars
  └── # AGENTS.md — This file provides guidance...

  backend/CLAUDE.md                                  3.4k chars
  └── # Backend Development — Commands, architecture...

  _docs/plans/auth-task.md           [task]          1.8k chars
  └── # Auth Refactor Task — Implement JWT refresh...

Pinned skills (2):

  researching                                        ~1.2k chars
  └── Explores codebases and evaluates approaches...

  reviewing                                          ~0.9k chars
  └── Reviews code against project rules...

Total: ~9.4k chars   re-injected on compaction
Harness: claude   ✓ hook re-injection supported
```

### `meridian context pin` — success feedback

```
$ meridian context pin CLAUDE.md
✓ Pinned: CLAUDE.md (2.1k chars)
  Re-injected on compaction in: auth-refactor

$ meridian context pin _docs/plans/auth-task.md --label task
✓ Pinned: _docs/plans/auth-task.md (1.8k chars) as "task"
  Re-injected on compaction in: auth-refactor

$ meridian context skill add researching
✓ Pinned skill: researching
  Re-injected on compaction in: auth-refactor
```

### `meridian context unpin`

```
$ meridian context unpin CLAUDE.md
✓ Unpinned: CLAUDE.md

$ meridian context skill remove researching
✓ Unpinned skill: researching
```

### `meridian status`

```
Space: auth-refactor (ws-abc123)
  Path:       /home/jimyao/gitrepos/my-project
  Harness:    claude
  Created:    2026-02-27 10:00:00

Session: active
  ID:         sess-xyz789
  Started:    2026-02-27 12:00:00 (1h 23m ago)
  Compactions: 2

Pinned context:
  Files (3):  CLAUDE.md, backend/CLAUDE.md, _docs/plans/auth-task.md
  Skills (2): researching, reviewing
  Total:      ~7.3k chars (re-injected on compaction)

Runs today: 12 (10 passed, 0 failed, 2 in-progress)
```

### Run start — verbose mode

```
$ meridian run create -p 'Review the auth flow' --verbose

Space:  auth-refactor (ws-abc123)
Pinned context injecting:
  + CLAUDE.md
  + backend/CLAUDE.md
  + _docs/plans/auth-task.md [task]
  + researching (skill)

Launching (claude-sonnet-4-6)...
Run: run-67890
```

Default mode (no `--verbose`) only prints the run ID:

```
$ meridian run create -p 'Review the auth flow'
run-67890
```

### After compaction (appears in harness output as additionalContext header)

```
[meridian] Compaction detected — re-injecting pinned context:
  CLAUDE.md               2.1k chars
  backend/CLAUDE.md       3.4k chars
  _docs/plans/auth-task.md [task]  1.8k chars
  researching (skill)     1.2k chars
Total: ~8.6k chars
```

### Warning: harness without hook support (Codex)

```
$ meridian context pin CLAUDE.md
✓ Pinned: CLAUDE.md (2.1k chars)

⚠ Warning: space harness is Codex, which does not support hooks.
  Pinned context will be injected at run start but NOT re-injected after compaction.
  Switch to a hook-capable harness (claude, opencode) for full compaction recovery.
```

---

## Example Workflows

### Workflow 1: Set up pinned context for a multi-day task

```bash
# Start a space for the auth refactor task
meridian space start --name auth-refactor

# Pin the files you'll always need
meridian context pin CLAUDE.md
meridian context pin backend/CLAUDE.md
meridian context pin _docs/plans/auth-task.md --label task

# Pin skills needed for this task
meridian context skill add researching

# Verify setup before starting work
meridian context list

# Run tasks — pinned context survives compaction automatically
meridian run create -p 'Implement JWT refresh token rotation'
meridian run create -p 'Add OAuth callback handler'
meridian run create -p 'Write integration tests'

# Task complete — unpin task-specific file, keep project rules
meridian context unpin _docs/plans/auth-task.md
```

### Workflow 2: Check what survived compaction

```bash
# After a long session with compaction events
meridian status
# → "Session: active, Compactions: 3"
# → "Pinned context: Files (2), Skills (1), Total: ~5.1k chars (re-injected on compaction)"

# If context looks wrong in the harness, inspect what was re-injected
meridian context list --verbose

# Adjust if needed
meridian context pin _docs/plans/missed-file.md
```

### Workflow 3: Orchestrate loop with stable context

```bash
# Supervisor sets up space context at loop start
meridian context pin _docs/plans/dx-improvements.md --label dx-plan
meridian context pin .orchestrate/skills/reviewing/SKILL.md --label review-skill

SESSION=$(meridian space id)

# Each run in the loop inherits pinned context automatically
R=$(meridian run create --background -m codex \
    -f @dx-11-task --session $SESSION)
meridian run wait $R

# After compaction (harness compacts automatically), context is re-injected
# The next run starts with full pinned context — no manual re-injection needed
R2=$(meridian run create --background -m codex \
     -f @dx-11-review --session $SESSION)
meridian run wait $R2
```

### Workflow 4: Different pin sets per task

```bash
# Auth space — auth-specific pins
meridian space start --name auth-work
meridian context pin _docs/features/fb-authentication/README.md
meridian context skill add researching

# Separate streaming space — different pin set
meridian space start --name streaming-work
meridian context pin _docs/features/fb-streaming/README.md
meridian context skill add reviewing

# Each space has isolated pins — no cross-contamination
```

---

## Design Decisions

### 1. `meridian context` as a separate command group

**Options considered:**

| Command shape | Pros | Cons |
|---|---|---|
| `meridian pin add/list/remove` | Short | Pollutes top-level namespace; "pin" is ambiguous |
| `meridian context pin/unpin/list` | Semantic: describes what you're managing | Slightly more verbose |
| `meridian space pin/unpin` | Keeps space ops grouped | Conflates lifecycle mgmt with context mgmt |

**Decision: `meridian context`.**

"Context" is what the user cares about: what gets injected into the LLM context window.
Space commands manage the space lifecycle (start/stop/resume/sessions). Context
management is a separate concern. Also, `context-reinject` and `meridian context list`
are already referenced in space-gaps.md #3, establishing the naming direction.

### 2. Files use paths, not `@` space references

`@` references in the existing design (OL-5) refer to **space-written content**
stored in `.meridian/sessions/<id>/<name>.md`. Pinned files are **existing project files**
on disk.

Mixing the two reference systems would confuse users. Files → paths. Space content → `@name`.

### 3. Space-scoped, not global or per-run

- **Global:** Agent profiles (`skills: [...]`) already handle global skill injection. A global
  pin set would duplicate this without adding value.
- **Per-run:** `-f <file>` already handles per-run file injection. Adding `--pin` to
  `run create` would cause runs to mutate space state as a side effect — surprising.
- **Space:** The right scope. Pins are task-specific ("I'm working on auth, always
  inject auth docs") and should persist for the space lifetime.

### 4. Skills have separate subcommand (`meridian context skill add/remove`)

Files and skills are different types of content with different resolution paths. Separating
them (`meridian context pin <file>` vs `meridian context skill add <skill>`) makes the
distinction explicit and avoids a `--type` flag.

### 5. No `--pin` flag on `run create`

Rejected: `meridian run create --pin CLAUDE.md --pin-session`

Per-run file injection uses `-f <file>` (already exists). Adding `--pin` would blur the
boundary between run-level and space-level configuration. Keep them separate.

### 6. Verbose mode opt-in for run-start display

Default: run ID only (script-friendly). `--verbose`: show pinned context being injected.
Follows the existing `--verbose`/`--quiet` pattern established in DX-2.

### 7. Skills in agent profile vs space pins

These are complementary, not competing:

| Mechanism | Scope | Mutability | Purpose |
|-----------|-------|------------|---------|
| `skills: [...]` in agent profile | All runs using that profile | Static (edit file) | Define the agent's role |
| `--skills` on `run create` | Single run | Per-invocation | One-off skill additions |
| `meridian context skill add` | Current space | Dynamic | Task-specific persistent skills |

---

## Storage Format

Pinned context stored as JSON in the space directory:

`.meridian/space/<space-id>/pinned.json`:
```json
{
  "version": 1,
  "files": [
    { "path": "CLAUDE.md", "label": null },
    { "path": "backend/CLAUDE.md", "label": "backend-rules" },
    { "path": "_docs/plans/auth-task.md", "label": "task" }
  ],
  "skills": ["researching", "reviewing"]
}
```

**Why JSON, not SQLite:**
- The `context-reinject` hook reads this without importing the full DB stack
- Human-readable and debuggable — users can inspect and edit it directly
- No concurrent write risk (only the CLI writes it; hooks read-only)

**Path resolution:** Relative to space root (cwd at space creation time). Absolute
paths accepted. Symlinks followed.

---

## Hook Integration

The `context-reinject` hook handler (space-gaps.md #3) reads from `pinned.json`:

```python
def context_reinject(space_id: str, run_id: str) -> str:
    pins = load_pinned(space_id)   # reads pinned.json
    skill_names = get_run_skills(run_id)  # skills from run creation, not re-read from profile

    parts = []
    for pin in pins.files:
        content = read_file(resolve_path(pin.path, space_root))
        label = pin.label or pin.path
        parts.append(f"## {label}\n\n{content}")

    for skill_name in pins.skills:
        content = load_skill_content(skill_name)
        parts.append(f"## Skill: {skill_name}\n\n{content}")

    return "\n\n---\n\n".join(parts)
```

Called only when `source: compact` in `SessionStart` hook. Not called on `source: startup`
(context is already present from initial prompt composition).

---

## Open Questions

1. **Size cap:** Should `meridian context pin` warn when total pinned context exceeds
   a threshold (e.g., >20k chars)? Over-pinning defeats the purpose — if everything is
   pinned, compaction becomes a forcing function for prompt bloat.

2. **File watch:** Should meridian warn if a pinned file has been deleted or moved since
   pinning? Could be caught at pin time (warn if file doesn't exist) or at run start.

3. **Skill validation:** Should `meridian context skill add <skill>` validate that the
   skill name resolves in the current skill path? Typos here would silently fail at
   hook time.

4. **Codex limitation scope:** The Codex-no-hooks warning (shown in mockup) is correct
   but potentially noisy. Should it appear once (on first `context pin` in a Codex
   space) or every time?

5. **Context ordering:** In the re-injected block, should pinned files come before or
   after skill instructions? Recommendation: files first (more specific to task),
   skills last (more general instructions).

6. **`meridian context clear` confirmation:** Destructive operation — should it require
   `--yes` to avoid accidents? Or is it low-stakes enough to not need confirmation
   (pins can be re-added easily)?
