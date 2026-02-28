# Space System Prompt Composition for Meridian-Channel

**Status:** Revision 4 (Final Design — Ready for Implementation)
**Date:** 2026-02-28
**Target Audience:** Agents (supervisors, coders, reviewers), operators
**Key Architecture:**
- Multiple supervisors per space (not one-at-a-time)
- Supervisors can spawn other supervisors (hierarchy)
- Skills embedded in each supervisor's system prompt
- SQLite is primary state; JSON files for human readability (no parallel state)

---

## Concepts & Definitions

**Space:** A container for a supervisor agent and its spawned agents. Defined by `space_id`, space metadata (agent, skills), and session state. Lives in `.meridian/spaces/<space_id>/`.

**Supervisor:** The orchestrating agent running within a space. Spawns other agents, manages work, maintains space state. Launched via `meridian space start <id>` with skills injected into system prompt.

**Run/Agent:** A single execution of an agent (supervisor or spawned by supervisor). Launched via `meridian run create` with independent skills.

**Session:** Active Claude conversation with supervisor. Can resume after compaction via session ID.

**Skills:** Reusable instruction modules in `.claude/skills/`. Skills are:
- Static at space creation (set once, not modified dynamically)
- Embedded in supervisor's system prompt (loaded from SKILL.md files)
- Independent when spawning agents (agents get their own skill sets, not merged with space skills)

---

## Executive Summary

**Problem:** When Claude compacts context, supervisor agents lose skills they need to continue managing space agents.

**Solution:** Embed full skill file content in the supervisor's system prompt at space launch. On relaunch (after compaction), automatically reinject the system prompt with the same skills.

**Why This Approach:**
- ✅ Simplest for agents (skills always available, no state management)
- ✅ Works across all harnesses (Claude, Codex, OpenCode, Cursor)
- ✅ Lowest implementation complexity (reuses existing prompt composition)
- ✅ No dynamic skill commands needed (skills are static at space creation)
- ✅ Supervisor doesn't need to request context restoration

---

## Core Architecture

### Data Model

**Space Metadata** (`.meridian/spaces/<space-id>/space.json`):
```json
{
  "space_id": "w1-abc123",
  "name": "feature-x",
  "created_at": "2026-02-28T03:00:00Z",
  "agent": "supervisor",
  "skills": ["researching", "reviewing", "planning"],
  "status": "active"
}
```

**Key Insight:** Skills are **static** — set once at space creation, never changed dynamically.

### System Prompt Composition

When supervisor launches, compose system prompt:

```
use these skills to aid you:

Skill path: /path/to/.claude/skills/researching

[full content of SKILL.md for researching]

---

Skill path: /path/to/.claude/skills/reviewing

[full content of SKILL.md for reviewing]

---

Skill path: /path/to/.claude/skills/planning

[full content of SKILL.md for planning]
```

Pass to harness: `claude ... --system-prompt "use these skills..."`

### Lifecycle Flow

```
1. User creates space with skills:
   meridian space create --name feature-x --skills researching,reviewing,planning
   → space.json created with static skills

2. Supervisor launches:
   → Load space.json
   → Read skill files from .claude/skills/*/SKILL.md
   → Compose system prompt with full skill bodies + paths
   → Pass to harness: --system-prompt "use these skills..."

3. Supervisor executes, context grows...

4. Claude compacts internally (transparent to meridian)

5. Supervisor relaunches (session resume or new run):
   → Load space.json (same)
   → Read skill files (same)
   → Compose system prompt (same)
   → Skills automatically available, no restoration logic needed
```

### Files and State

**Primary State (SQLite):**
```
runs.db (existing database)
├── spaces table           (space metadata: supervisor models, skills, status, created_at)
├── space_files table      (file state: what supervisor/agents have created/modified)
└── space_sessions table   (active sessions: session_id, resumed_at per supervisor)
```

**Human-Readable Output (Optional JSON):**
```
.meridian/
└── spaces/
    └── <space-id>/
        └── space-summary.md   (human-readable: list of supervisors, skills, files, sessions)
```

**Architecture:** SQLite is **primary authoritative state** (same as current system). Space state lives in `runs.db`. Optional JSON/markdown exports for human readability and backup, not for primary storage. This avoids dual-state problems by extending the existing SQLite pattern.

---

## CLI Interface

### Space Commands

```bash
# Start space (creates + launches supervisor with skills)
meridian space start \
  --name feature-x \
  --agent supervisor \
  --skills researching,reviewing,planning

# Launch additional supervisor in same space
meridian space spawn-supervisor \
  --space-id w1-abc123 \
  --agent orchestrator \
  --skills planning,monitoring

# Show space (including supervisors, skills, sessions)
meridian space show w1-abc123
# Output:
#   space_id: w1-abc123
#   supervisors: [supervisor (session ID: ...), orchestrator (session ID: ...)]
#   base_skills: researching, reviewing, planning
#   sessions: 2 active

# List spaces
meridian space list

# Close space (closes all supervisors)
meridian space close w1-abc123
```

**Skills are static per supervisor:** Each supervisor gets skills when spawned. No dynamic add/remove. Skills embedded in each supervisor's system prompt—no restoration needed after compaction.

---

## Agent Interaction Model

### Supervisors (Space Orchestrators)

```bash
# Space created with initial supervisor + skills
meridian space start --name feature-x --agent supervisor --skills researching,reviewing

# Supervisor runs with researching, reviewing in system prompt
# Supervisor can spawn other supervisors (hierarchical coordination)

meridian space spawn-supervisor --space-id w1-abc123 --agent orchestrator --skills planning,monitoring
# Orchestrator runs with planning, monitoring in system prompt (independent of initial supervisor skills)
```

### Spawned Agents (Independent Skill Sets)

```bash
# Supervisor or orchestrator spawns agents with their own independent skill sets
meridian run -a coder -skills scratchpad,planning
meridian run -a reviewer -skills reviewing

# Each agent gets its own skill set, not merged with any supervisor's skills
```

**Key Model:** Supervisors can form a hierarchy (supervisor spawns supervisor), and each agent (supervisor or spawned-agent) gets its own independent skill set embedded in its system prompt.

---

## Implementation Roadmap

### Phase 1: Core

**Files to create/modify:**
- `src/meridian/lib/space/state.py` — space CRUD (load/save space.json)
- `src/meridian/lib/space/supervisor.py` — supervisor launch logic
  - Load space metadata
  - Load skill files
  - Compose system prompt with skill bodies + paths
  - Pass to harness via `--system-prompt`

**Changes:**
- Space creation stores agent + skills in space.json (one-time)
- Supervisor launch composition uses space.json skills
- All harnesses support --system-prompt or fallback to prompt injection

**Test:**
- Create space → launch supervisor → verify skills in system prompt
- Verify supervisor works across Claude, Codex, OpenCode
- Verify compaction doesn't lose skills (they're in system prompt)

### Phase 2: File Management

**Files to create/modify:**
- `src/meridian/lib/space/files.py` — track space files
- Supervisor/agents update files.json as they work

**Test:**
- Supervisor creates files → update files.json
- Agent modifies files → files.json updated
- Space show/list displays current file state

### Phase 3: Polish & Optimization

**Files to create/modify:**
- CLI: `meridian space` subcommands (show, list, close, files)
- Documentation

**Test:**
- Full end-to-end: create space → launch supervisor with skills → supervisor spawns agents → agents work → verify state persists

---

## Harness Support

### Phase 1 Scope: Claude Supervisors Only

Space supervisors (launched via `space start / space spawn-supervisor`) are **Claude-only** by design. The existing `launch.py:266-278` enforces this with explicit error on non-Claude models:

```python
if harness_id != HarnessId("claude"):
    raise ValueError("Space supervisor only supports Claude harness models.")
```

**Future:** Phase 2+ can extend to other harnesses if needed, but Phase 1 targets Claude.

### Spawned Agents (via `meridian run create`)

Agents spawned by supervisors (both supervisor-to-agent and agent-to-agent) use harness-agnostic `_run_prepare.py` and work across all harnesses:
- ✅ **Claude:** Skills injected via system prompt + prompt composition
- ✅ **Codex:** Skills injected via prompt composition (adapters drop `--skills` flag)
- ✅ **OpenCode:** Skills injected via prompt composition
- ⚠️ **Cursor:** To be validated (hook config exists, adapter may be missing)

---

## Error Handling & Constraints

### Skill File Loading
- **Missing skill file:** Fail fast at space launch with clear error. User must add skill or remove from space skills list.
- **Invalid SKILL.md:** Parse error → fail at space launch. User must fix skill file.
- **Skill content changes mid-session:** Supervisor sees v1 in system prompt; agents spawned within space get v2 (loaded fresh). Warn on resume if content hash changes.

### System Prompt Size
- **Token budget:** Configurable, default 30% of supervisor's context window. Configurable via `meridian config set system_prompt_token_budget_percent 30`.
- **Exceeds budget:** Warn at space creation if skills exceed budget. Don't hard-fail—let agents optimize naturally. Agents self-manage (only run 1-2 supervisors for best performance).
- **Projected token cost:** ~844 tokens per skill (based on local corpus). Estimate: 10 skills ≈ 8.4k tokens, 20 skills ≈ 16.8k tokens.

### Pinned Files on Resume
- **File deleted after pinning:** If a pinned file is deleted (user moves/deletes it, symlink broken, temp location cleaned up), space resume:
  - Warn: "Pinned file not found: src/main.py"
  - Skip the missing file (don't include in prompt injection)
  - Include note in system prompt: "Note: Previously pinned file not found (may have been deleted or moved)"
- **Partial files.json corruption:** If files.json corrupts mid-session, space is paused with clear error.

### Concurrent Writes & Supervisor Spawning

**Supervisor spawning:** Multiple supervisors can be spawned in the same space sequentially or concurrently. No exclusion. Each supervisor gets a unique session ID.

**State protection:** Space state (files.json, pinned context, session list) is protected by:
- **Lock file:** `space_lock_path()` prevents concurrent writes to space metadata (files.json updates, session list updates)
- **SQLite WAL:** `PRAGMA journal_mode = WAL` for safe concurrent reads/writes to space tables
- **Explicit transactions:** File operations and supervisor spawning use explicit SQLite transactions for atomicity

**Acquisition semantics:**
- Lock is per-space (not per-supervisor)
- Lock acquisition: Try to acquire; if locked, wait up to 5 seconds, then fail with clear error
- Stale lock cleanup: PID check on lock; if process gone, auto-cleanup and re-acquire
- Lock scope: Only protects space metadata writes, not supervisor execution

---

## Agent-Centric Design

This approach is designed **for agent usability**:

**For Supervisors:**
```
✅ Skills always available in system context
✅ No commands to restore/refresh skills
✅ No state machine to track skill add/remove
✅ Compaction is transparent (system prompt included on every request)
```

**For Agents You Spawn:**
```
✅ Get their own independent skill sets
✅ No merging with space skills
✅ Launched with clear `-skills` parameter
```

**For Implementation (agents like you):**
```
✅ Reuse existing skill file loading (`load_skill.py`)
✅ Reuse existing prompt composition (`compose_run_prompt_text`)
✅ No new state tracking, hooks, or restoration logic
✅ Single integration point: supervisor launch
```

---

## Building on Existing Code

**This design extends existing SQLite-first architecture:**

| Existing Component | How We Extend It |
|--------------------|-----------------|
| `launch.py:156-183` | Already composes system prompt. We extend to load and embed skill file bodies + paths. |
| `SkillRegistry` | Already loads skill files. We call to get full SKILL.md content for system prompt composition. |
| `space` table (SQLite) | Already stores space metadata. We add `skills TEXT` column for supervisor skills. |
| `space_sessions` table (SQLite) | Already tracks sessions. We extend to store skills per supervisor (multiple supervisors). |
| `pinned_files` table (SQLite) | Already tracks pinned context. We reuse as-is for space file management. |
| `context.py:inject_pinned_context()` | Already injects pinned files into prompts. We extend to skip missing files with warning (vs hard error). |
| `space_lock_path()` + `cleanup_orphaned_locks()` | Already exists for space locking. We reuse for concurrent write protection (not supervisor exclusion). |

**Architecture decision: SQLite is authoritative state storage.** No parallel JSON state system. Clean extension of existing pattern.

---

## Scaling & Future Considerations

### Prompt Token Pressure (100+ Skills)

**Current Risk:** 100 skills ≈ 84,357 tokens (Codex estimate)

**Mitigation Strategies (Phase 2+):**
1. **Lazy-load:** Only embed frequently-used skills; allow supervisor to load others on demand
2. **Summarize:** Use skill summary in system prompt, full content via file reference
3. **Compress:** Strip comments/examples from skill files in system prompt
4. **Selective:** MVP only embeds top N skills by priority

**Decision Point:** If MVP space > 50 skills in real usage, implement one of above.

### Multi-Agent Spaces

**Future:** If space scales to 50+ concurrent agents:
- Consider SQLite for space state (vs JSON)
- Add file locking/conflict resolution
- Implement snapshot/restore (like Revised design) as upgrade path

---

## Comparison to Alternatives

| Aspect | This Approach | Original Design | Revised Design |
|--------|-----------------|-----------------|----------------|
| **Implementation Complexity** | Medium (reuses existing code) | Medium-High | High (architectural pivot) |
| **Agent UX (Supervisor)** | Simple: skills always in system prompt | Complex: manage skill add/remove state | Simple but implicit |
| **Skill Management** | Static at space creation ✅ | Dynamic (`context skill add/remove`) | Static at creation ✅ |
| **Code Reuse** | High (extends `launch.py`, `SkillRegistry`, existing pinned context) | Medium | Low |
| **Harness Support** | Claude supervisors only; all harnesses for spawned agents | All harnesses (complex fallbacks) | All harnesses |
| **Failure Mode: Skill Loss** | ⚠️ System prompt gone if session expires → restart supervisor | Requires manual restore | ✅ Snapshot provides recovery |
| **Scaling: 100+ Skills** | ⚠️ System prompt token pressure (needs Phase 2 mitigation) | ⚠️ Same problem | ✅ Snapshot avoids prompt inflation |
| **Scaling: 1000+ Files** | ⚠️ Concurrent read overhead, pinned context injection slow | ⚠️ Same problem | ✅ Snapshot isolation better |
| **Multi-Agent Coordination** | Supervisor + agents in same space, independent skills | Similar model | Similar model |
| **Point-in-Time Recovery** | No (stateless restart always possible) | Limited | ✅ Yes (snapshots) |

---

## Resolved Questions

**Phase 1 Decisions (from user):**
1. ✅ **Multiple supervisors per space, supervisor hierarchy.** A space can have multiple concurrent supervisors, and supervisors can spawn other supervisors (hierarchy). No hard exclusion. Lock file protects concurrent access to space state (files.json, pinned context), not supervisors themselves.
2. ✅ **Configurable token budget, warn don't fail.** Don't hardcode limit. Agents self-optimize (only 1-2 supervisors for best performance). Warn if skills exceed budget, but allow it. Config key: `meridian config set system_prompt_token_budget_percent 30`.
3. ✅ **Missing file: warn and skip.** If a pinned file is deleted/moved after pinning, skip it on resume with warning note in system prompt.

**Phase 2+ Decisions:**
1. **Skill embedding format:** Full SKILL.md in system prompt, or stripped (comments/examples removed)?
2. **Disaster recovery:** Is stateless restart (skills always in system prompt) sufficient, or do we need periodic JSON exports for backup?
3. **Skill content versioning:** Track skill file hash to detect changes between session runs?
4. **Archive old design docs:** Move `lifecycle-hooks-design.md` and `lifecycle-hooks-revised.md` to `_docs/plans/_archive/` to avoid implementer confusion.

---

## Why Agents Will Like This

1. **No Context Hunting:** System prompt always has skills. No "did the supervisor lose researching skill?" debugging.
2. **Deterministic Behavior:** Same space = same system prompt = same skill set. No dynamic state to manage.
3. **Clear Boundaries:** Supervisor skills vs agent skills are independent. No confusion about inheritance/merging.
4. **Fast Launches:** No skill reinjection logic, no state restoration, no compaction detection. Just load and go.
5. **Debuggable:** System prompt is readable, testable, predictable. Skills are there or not — simple.

---

## Implementation Checklist (Phase 1)

**Database:**
- [ ] Add `skills TEXT` column to `spaces` table (SQLite migration 003)
- [ ] Add `supervisor_model TEXT` column to track which model supervised each space
- [ ] Ensure `space_sessions` table has columns: space_id, session_id, supervisor_agent, skills_json, created_at, status

**Code Changes:**
- [ ] Extend `launch.py` system prompt composition to include skill file bodies + paths
- [ ] Load skill files via existing `SkillRegistry` at supervisor launch
- [ ] Compose skill section into system prompt: "use these skills to aid you: [skill bodies with paths]"
- [ ] Pass to harness via existing `--system-prompt` flag (Claude-only)
- [ ] Add token budget validation at space launch (warn if skills exceed configurable budget; don't hard-fail)
- [ ] Update `inject_pinned_context()` to skip missing files with warning (not hard error)
- [ ] Implement space-level locking: `try_acquire_lock()` with timeout + PID-based cleanup

**CLI Commands:**
- [ ] `meridian space start --name <name> --agent <agent> --skills <skills>` (create + launch supervisor)
- [ ] `meridian space spawn-supervisor --space-id <id> --agent <agent> --skills <skills>` (add supervisor to space)
- [ ] `meridian space show <id>` (list supervisors, sessions, skills)
- [ ] `meridian space list` (list all spaces)
- [ ] `meridian space close <id>` (close all supervisors)

**Testing:**
- [ ] Create space → launch supervisor → verify skills in system prompt
- [ ] Launch second supervisor in same space → verify both run independently
- [ ] Compaction → resume → verify skills still there
- [ ] Resume with missing pinned file → verify warning and skip
- [ ] Token budget warning: create space with 50+ skills → verify warning logged

**Documentation:**
- [ ] Update docs: Claude-only supervisor support in Phase 1, multi-supervisor model, error cases, token budgets
- [ ] Add example: multi-supervisor workflow (supervisor → orchestrator → agents)

---

## Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Prompt grows too large (100+ skills) | Medium | Lazy-load in Phase 2 if needed |
| System prompt flag not supported in some harnesses | Low | Fallback to prompt injection (already implemented) |
| Skill files change between runs | Low | Load at supervisor launch (always fresh) |
| Space state becomes large | Low | JSON is sufficient for MVP; upgrade to SQLite if needed |

---

## Next Steps

1. **This Document:** Review and refine (multi-model review loop)
2. **Consensus:** All reviewer models agree on architecture
3. **Phase 1 Implementation:** Create space state + supervisor composition
4. **Integration Test:** Verify across harnesses
5. **Phase 2+:** File management, scaling strategies

