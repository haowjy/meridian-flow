# Space Persistence for Meridian-Channel (Agent Profiles Define Skills)

**Status:** Revision 5 (Simplified — Agent Profiles Own Skills)
**Date:** 2026-02-28
**Target Audience:** Agents (primary agent, child agents, coders, reviewers), operators
**Key Architecture:**
- Multiple agents per space
- The primary agent is the first agent launched in a space via `space start`
- Primary and child agents are runtime-identical; they differ only by launch order/role label
- Agent profiles define which skills are available (static, not per-space)
- Skills are loaded fresh on every agent launch/resume (survives compaction)
- SQLite tracks space state; no parallel JSON state system

---

## Concepts & Definitions

**Space:** A container for an agent's work. Defined by `space_id`, agent type, and session state. Lives in `.meridian/spaces/<space_id>/`.

**Primary agent:** The agent launched first in a space via `meridian space start`. Simply the first agent to run in that space.

**Child agent:** Any agent spawned after the primary agent (via `meridian run create` or by the primary agent's actions).

**Agent:** An execution instance. All agents are capability-identical; "primary" and "child" are role labels based on launch order.

**Session:** Active conversation with an agent. Can resume after compaction via session ID.

**Skills:** Defined in agent profiles (not per-space). Loaded fresh on each agent launch. When an agent resumes after compaction, its skills are reloaded automatically.

---

## Executive Summary

**Problem:** When Claude compacts context, agent sessions lose skills they've been using.

**Solution:** Skills are defined in agent profiles, not spaces. When an agent launches or resumes (after compaction), its profile skills are loaded fresh. No state to restore.

**Why This Approach:**
- ✅ Simplest (skills are profile property, not per-space configuration)
- ✅ Deterministic (same agent = same skills)
- ✅ Works across harnesses (all harnesses load agent profiles the same way)
- ✅ No skill composition machinery (agent profiles own their skill set)
- ✅ Agents don't manage skill state (skills reload automatically)
- ✅ Custom skills: user edits agent profile, not space config

---

## Core Architecture

### Data Model

**Space** (stored in SQLite `spaces` table):
- `space_id`: unique identifier
- `name`: user-given name
- `agent_type`: which agent (e.g., "orchestrator") — defines skills
- `primary_session_id`: session ID of the agent running in this space
- `status`: active, paused, completed
- `created_at`, `updated_at`: timestamps

**Key Insight:** Skills come from the agent profile, not the space. When an agent launches, its profile skills are loaded automatically.

### Lifecycle Flow

```
1. User creates space:
   meridian space start --name feature-x --agent orchestrator
   → Loads orchestrator agent profile (which defines skills)
   → Launches agent in new space

2. Agent launches:
   → Agent profile is loaded (carries its skill set)
   → Skills loaded by harness (Claude loads full SKILL.md content)
   → Agent executes

3. Agent spawns child agents:
   meridian run create --agent reviewer
   → Loads reviewer agent profile (different skill set)
   → Launches in same space as child agent

4. Claude compacts internally (transparent)

5. Agent resumes:
   meridian space resume --space-id w1-abc123
   → Load agent profile (same as step 1)
   → Skills reloaded automatically
   → No restoration logic needed
```

### Files and State

**Primary State (SQLite):**
```
runs.db (existing database)
├── spaces table           (space metadata: agent_type, primary_session_id, status)
├── runs table             (agents/runs in this space, linked to sessions)
└── pinned_files table     (persistent context files for the space)
```

**Human-Readable Output (Optional JSON):**
```
.meridian/
└── spaces/
    └── <space-id>/
        └── space-summary.md   (human-readable: primary agent + child agents, skills, files, sessions)
```

**Architecture:** SQLite is **primary authoritative state** (same as current system). Space state lives in `runs.db`. Optional JSON/markdown exports for human readability and backup, not for primary storage. This avoids dual-state problems by extending the existing SQLite pattern.

---

## CLI Interface

### Space Commands

```bash
# Start space with a primary agent
# (agent profile defines its skills)
meridian space start --name feature-x --agent orchestrator

# Show space details
meridian space show w1-abc123
# Output:
#   space_id: w1-abc123
#   primary_agent: orchestrator (session ID: s-abc-123)
#   status: active

# List spaces
meridian space list

# Close space
meridian space close w1-abc123

# Resume space (after compaction)
meridian space resume --space-id w1-abc123
```

**Agent profiles define skills:** Each agent carries its skills from its profile. When launched in a space, it loads those skills automatically. No per-space skill configuration.

If a user wants different skills, they create a different agent profile (e.g., `researcher` vs `coder`), each with its own skill set defined.

---

## Primary and Child Agents

All agents are runtime-identical. "Primary" only means "first launched via `space start`."

```bash
# Space created with initial primary agent + skills
meridian space start --name feature-x --agent orchestrator --skills researching,reviewing

# Spawn child agents with independent skills
meridian space spawn --space-id w1-abc123 --agent reviewer --skills reviewing
meridian space spawn --space-id w1-abc123 --agent coder --skills scratchpad,planning
```

**Interaction model:**
- Primary agent can spawn child agents.
- Child agents can spawn additional child agents.
- Each agent gets its own skill set; there is no implicit skill inheritance or merging.

### Spawned Agents (Independent Skill Sets)

```bash
# Primary or child agents can spawn agents with their own independent skill sets
meridian run -a coder -skills scratchpad,planning
meridian run -a reviewer -skills reviewing

# Each agent gets its own skill set, not merged with any other agent's skills
```

**Key Model:** The primary/child distinction is organizational only. All agents can coordinate hierarchically and each agent gets its own independent skill set embedded in its system prompt.

---

## Implementation Roadmap

### Phase 1: Core

**Files to create/modify:**
- `src/meridian/lib/space/state.py` — space CRUD (load/save space.json)
- `src/meridian/lib/space/primary_agent.py` — primary agent launch logic
  - Load space metadata
  - Load skill files
  - Compose system prompt with skill bodies + paths
  - Pass to harness via `--system-prompt`

**Changes:**
- Space creation stores agent + skills in space.json (one-time)
- Primary agent launch composition uses space.json skills
- All harnesses support --system-prompt or fallback to prompt injection

**Test:**
- Create space → launch primary agent → verify skills in system prompt
- Verify primary agent works across Claude, Codex, OpenCode
- Verify compaction doesn't lose skills (they're in system prompt)

### Phase 2: File Management

**Files to create/modify:**
- `src/meridian/lib/space/files.py` — track space files
- Agents update files.json as they work

**Test:**
- Primary agent creates files → update files.json
- Agent modifies files → files.json updated
- Space show/list displays current file state

### Phase 3: Polish & Optimization

**Files to create/modify:**
- CLI: `meridian space` subcommands (show, list, close, files)
- Documentation

**Test:**
- Full end-to-end: create space → launch primary agent with skills → spawn child agents → agents work → verify state persists

---

## Harness Support

### Phase 1 Scope: Primary Agents Are Harness-Agnostic

Any harness-supported agent can be the primary agent, because "primary" is a role label based on launch order, not an implementation subtype.

**All harnesses can launch a primary agent.** However, feature availability varies:

| Harness | Primary Agent | System-Prompt Skills | Fallback |
|---------|---------------|----------------------|----------|
| **Claude** | ✅ Yes | ✅ Native `--system-prompt` flag | — |
| **Codex** | ✅ Yes | ⚠️ Via prompt injection | Skill content embedded in prompt text |
| **OpenCode** | ✅ Yes | ⚠️ Via prompt injection | Skill content embedded in prompt text |
| **Cursor** | ✅ Yes | ⚠️ To be validated | TBD |

**Key:** Primary agents launch the same way on all harnesses. Skills are always embedded in the prompt (either via `--system-prompt` flag or prompt text injection). The primary agent's capabilities are identical across harnesses; only the delivery mechanism varies.

- `space start` launches the primary agent (any harness) with skills embedded.
- `space spawn` and `run create` launch child agents with independent skill sets.
- No Claude-only role constraint: all harnesses follow the same primary/child model.

### Spawned Agents (via `meridian run create`)

Agents spawned by primary or child agents use harness-agnostic `_run_prepare.py` and work across all harnesses:
- ✅ **Claude:** Skills injected via system prompt + prompt composition
- ✅ **Codex:** Skills injected via prompt composition (adapters drop `--skills` flag)
- ✅ **OpenCode:** Skills injected via prompt composition
- ⚠️ **Cursor:** To be validated (hook config exists, adapter may be missing)

---

## Error Handling & Constraints

### Skill File Loading
- **Missing skill file:** Fail fast at space launch with clear error. User must add skill or remove from space skills list.
- **Invalid SKILL.md:** Parse error → fail at space launch. User must fix skill file.
- **Skill content changes mid-session:** Already-running agents keep v1 in their system prompt; newly spawned agents get v2 (loaded fresh). Warn on resume if content hash changes.

### System Prompt Size
- **Token budget:** Configurable, default 30% of primary agent's context window. Configurable via `meridian config set system_prompt_token_budget_percent 30`.
- **Exceeds budget:** Warn at space creation if skills exceed budget. Don't hard-fail; let agents optimize naturally (for example, one primary plus a small number of child agents).
- **Projected token cost:** ~844 tokens per skill (based on local corpus). Estimate: 10 skills ≈ 8.4k tokens, 20 skills ≈ 16.8k tokens.

### Pinned Files on Resume
- **File deleted after pinning:** If a pinned file is deleted (user moves/deletes it, symlink broken, temp location cleaned up), space resume:
  - Warn: "Pinned file not found: src/main.py"
  - Skip the missing file (don't include in prompt injection)
  - Include note in system prompt: "Note: Previously pinned file not found (may have been deleted or moved)"
- **Partial files.json corruption:** If files.json corrupts mid-session, space is paused with clear error.

### Concurrent Writes & Agent Spawning

**Spawning model:** A space has one primary agent (first launched) and any number of child agents. Child agents can be spawned sequentially or concurrently. Each agent gets a unique session ID.

**State protection:** Space state (files.json, pinned context, session list) is protected by:
- **Lock file:** `space_lock_path()` prevents concurrent writes to space metadata (files.json updates, session list updates)
- **SQLite WAL:** `PRAGMA journal_mode = WAL` for safe concurrent reads/writes to space tables
- **Explicit transactions:** File operations and agent spawning use explicit SQLite transactions for atomicity

**Acquisition semantics:**
- Lock is per-space (not per-agent)
- Lock acquisition: Try to acquire; if locked, wait up to 5 seconds, then fail with clear error
- Stale lock cleanup: PID check on lock; if process gone, auto-cleanup and re-acquire
- Lock scope: Only protects space metadata writes, not agent execution

---

## Agent-Centric Design

This approach is designed **for agent usability**:

**For Primary Agent (first launched):**
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
✅ Single integration point: primary agent launch
```

---

## Building on Existing Code

**This design extends existing SQLite-first architecture:**

| Existing Component | How We Extend It |
|--------------------|-----------------|
| `launch.py:156-183` | Already composes system prompt. We extend to load and embed skill file bodies + paths. |
| `SkillRegistry` | Already loads skill files. We call to get full SKILL.md content for system prompt composition. |
| `space` table (SQLite) | Already stores space metadata. We add `skills TEXT` column for primary agent launch skills. |
| `space_sessions` table (SQLite) | Already tracks sessions. We extend to store role (`primary`/`child`) and skills per agent session. |
| `pinned_files` table (SQLite) | Already tracks pinned context. We reuse as-is for space file management. |
| `context.py:inject_pinned_context()` | Already injects pinned files into prompts. We extend to skip missing files with warning (vs hard error). |
| `space_lock_path()` + `cleanup_orphaned_locks()` | Already exists for space locking. We reuse for concurrent write protection (not primary agent exclusion). |

**Architecture decision: SQLite is authoritative state storage.** No parallel JSON state system. Clean extension of existing pattern.

---

## Scaling & Future Considerations

### Prompt Token Pressure (100+ Skills)

**Current Risk:** 100 skills ≈ 84,357 tokens (Codex estimate)

**Mitigation Strategies (Phase 2+):**
1. **Lazy-load:** Only embed frequently-used skills; allow agents to load others on demand
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
| **Agent UX (Primary + Child)** | Simple: skills always in system prompt | Complex: manage skill add/remove state | Simple but implicit |
| **Skill Management** | Static at space creation ✅ | Dynamic (`context skill add/remove`) | Static at creation ✅ |
| **Code Reuse** | High (extends `launch.py`, `SkillRegistry`, existing pinned context) | Medium | Low |
| **Harness Support** | Role-agnostic: any harness-supported agent can be primary; same model for child agents | All harnesses (complex fallbacks) | All harnesses |
| **Failure Mode: Skill Loss** | ⚠️ System prompt gone if session expires → restart affected agent | Requires manual restore | ✅ Snapshot provides recovery |
| **Scaling: 100+ Skills** | ⚠️ System prompt token pressure (needs Phase 2 mitigation) | ⚠️ Same problem | ✅ Snapshot avoids prompt inflation |
| **Scaling: 1000+ Files** | ⚠️ Concurrent read overhead, pinned context injection slow | ⚠️ Same problem | ✅ Snapshot isolation better |
| **Multi-Agent Coordination** | Primary + child agents in same space, independent skills | Similar model | Similar model |
| **Point-in-Time Recovery** | No (stateless restart always possible) | Limited | ✅ Yes (snapshots) |

---

## Resolved Questions

**Phase 1 Decisions (from user):**
1. ✅ **One primary agent plus child-agent hierarchy.** A space has one primary agent (first launch) and child agents can be spawned hierarchically. All agents are capability-identical; "primary" is only a role label. Lock file protects concurrent access to space state (files.json, pinned context), not agent execution.
2. ✅ **Configurable token budget, warn don't fail.** Don't hardcode limit. Agents self-optimize (usually one primary plus a few child agents). Warn if skills exceed budget, but allow it. Config key: `meridian config set system_prompt_token_budget_percent 30`.
3. ✅ **Missing file: warn and skip.** If a pinned file is deleted/moved after pinning, skip it on resume with warning note in system prompt.

**Phase 2+ Decisions:**
1. **Skill embedding format:** Full SKILL.md in system prompt, or stripped (comments/examples removed)?
2. **Disaster recovery:** Is stateless restart (skills always in system prompt) sufficient, or do we need periodic JSON exports for backup?
3. **Skill content versioning:** Track skill file hash to detect changes between session runs?
4. **Archive old design docs:** Move `lifecycle-hooks-design.md` and `lifecycle-hooks-revised.md` to `_docs/plans/_archive/` to avoid implementer confusion.

---

## Why Agents Will Like This

1. **No Context Hunting:** System prompt always has skills. No "did the primary agent lose researching skill?" debugging.
2. **Deterministic Behavior:** Same space = same system prompt = same skill set. No dynamic state to manage.
3. **Clear Boundaries:** Skill sets are independent per agent launch. No confusion about inheritance/merging.
4. **Fast Launches:** No skill reinjection logic, no state restoration, no compaction detection. Just load and go.
5. **Debuggable:** System prompt is readable, testable, predictable. Skills are there or not — simple.

---

## Implementation Checklist (Phase 1)

**Database Schema:**
- [ ] Verify `spaces` table has: `id`, `name`, `agent_type`, `primary_session_id`, `status`, `created_at` (mostly exists)
- [ ] Add `agent_type TEXT` column if missing (which agent profile this space uses)
- [ ] Verify `runs` table links runs to spaces via `space_id` (it does)

**Code Changes (lib/ modules):**
- [ ] Update `lib/space/launch.py`:
  - Load agent profile (defines skills)
  - Launch agent with that profile
  - Agent's skills are loaded by harness automatically (no manual composition)
  - Harness selection agnostic (any harness can be primary)
- [ ] Update `lib/space/context.py` to skip missing pinned files with warning (not hard error)
- [ ] Implement space-level locking in `lib/ops/space.py`: `try_acquire_lock()` with timeout + PID-based cleanup

**CLI Commands (in space.py):**
- [ ] Enhance `meridian space start --name <name> --agent <agent>` (add --agent param, remove --skills)
- [ ] Enhance `meridian space show <id>` to display primary agent type + session ID
- [ ] Verify `meridian space list`, `resume`, `close` still work (already exist)

**Testing:**
- [ ] Create space → launch primary agent → verify agent profile skills are loaded
- [ ] Resume space after context compaction → verify skills still there (fresh load)
- [ ] Spawn child agents (via `run create --agent <type>`) → verify independent skill sets
- [ ] Missing pinned file on resume → verify warning (not error)
- [ ] Test with different agent types (researcher, coder, orchestrator) → verify each loads correct skills

**Documentation:**
- [ ] Update docs: agent profiles define skills, not spaces
- [ ] Add example: creating space with different agent types
- [ ] Document how users customize skills (edit agent profile)

---

## Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Prompt grows too large (100+ skills) | Medium | Lazy-load in Phase 2 if needed |
| System prompt flag not supported in some harnesses | Low | Fallback to prompt injection (already implemented) |
| Skill files change between runs | Low | Load at primary agent launch (always fresh) |
| Space state becomes large | Low | JSON is sufficient for MVP; upgrade to SQLite if needed |

---

## Next Steps

1. **This Document:** Review and refine (multi-model review loop)
2. **Consensus:** All reviewer models agree on architecture
3. **Phase 1 Implementation:** Create space state + primary agent composition
4. **Integration Test:** Verify across harnesses
5. **Phase 2+:** File management, scaling strategies
