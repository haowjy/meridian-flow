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

# Optionally pass custom system prompt content
# (Claude: passed as flags; Codex/OpenCode: persisted and reinjected via plugin)
meridian space start --name feature-x --agent orchestrator \
  --system-prompt "Always prefer X approach" \
  --append-system-prompt "Additionally, remember Y constraint"

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

**Agent profiles define base skills:** Each agent carries its skills from its profile. When launched in a space, it loads those skills automatically.

**Optional custom system prompt:** Users can pass `--system-prompt` and `--append-system-prompt` flags. These are:
- **Claude:** Passed directly to the harness (`--system-prompt` and `--append-system-prompt`)
- **Codex/OpenCode:** Persisted in the space state and reinjected via prompt injection (see Harness Support section)

**No `--skills` CLI flag:** Skills come from agent profiles, not CLI configuration. If users want different skills, they create a different agent profile or edit their existing profile.

---

## Primary and Child Agents

All agents are runtime-identical. "Primary" only means "first launched via `space start`."

```bash
# Space created with initial primary agent
# Agent profile defines its skills; user can provide custom system prompt
meridian space start --name feature-x --agent orchestrator \
  --system-prompt "Custom constraint for this space"

# Spawn child agents with independent skill sets (from their own profiles)
meridian run create --agent reviewer
meridian run create --agent coder
```

**Interaction model:**
- Primary agent can spawn child agents.
- Child agents can spawn additional child agents.
- Each agent gets its own independent skill set from its profile; there is no implicit skill inheritance or merging.
- Custom `--system-prompt` and `--append-system-prompt` are space-level (inherited by all agents in that space).

### Spawned Agents (Independent Skill Sets)

```bash
# Primary or child agents can spawn agents with their own independent skill sets
# Each agent's profile defines its skills
meridian run create --agent coder
meridian run create --agent reviewer

# Each agent gets its own skill set from its profile, not merged with any other agent's skills
```

**Key Model:** The primary/child distinction is organizational only. All agents can coordinate hierarchically and each agent gets its own independent skill set from its profile.

---

## Implementation Roadmap

### Phase 1: Core

**Files to create/modify:**
- `src/meridian/lib/space/launch.py` — primary agent launch logic
  - Load agent profile (defines base skills)
  - Load `--system-prompt` and `--append-system-prompt` from space state (if provided)
  - **Claude:** Pass flags directly: `--system-prompt <content> --append-system-prompt <content>`
  - **Codex/OpenCode:** Inject skill content + custom system prompt into prompt text
  - Store custom system prompt in space state (SQLite) for Codex/OpenCode reinjection
- `src/meridian/lib/space/context.py` — enhance context injection
  - Include stored system prompt from previous runs (Codex/OpenCode persistence)
- `.opencode/plugins/space-system-prompt-injector.ts` (new) — OpenCode plugin
  - On each conversation start, reinject stored system prompt from space state
  - Works for new conversations and post-compaction resumptions

**CLI Changes:**
- Add `--system-prompt <text>` and `--append-system-prompt <text>` to `space start` and `space resume`
- **Remove entirely:** `--skills` CLI flag (agent profiles define skills, no user configuration)

**Data Changes:**
- Store custom `--system-prompt` and `--append-system-prompt` content in `spaces` table (if provided)
- Retrieve on resume and pass to harness or plugin

**Test:**
- Create space with custom `--system-prompt` → launch primary agent → verify Claude receives flag
- Create space with Codex/OpenCode → verify system prompt injected into prompt
- Resume Codex/OpenCode space after compaction → verify plugin reinjects system prompt
- Verify primary agent works across Claude, Codex, OpenCode
- Verify `--skills` flag no longer exists on CLI

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

**All harnesses can launch a primary agent.** However, system-prompt persistence varies:

| Harness | Primary Agent | System-Prompt Flags | Persistence Strategy |
|---------|---------------|----------------------|----------|
| **Claude** | ✅ Yes | ✅ `--system-prompt` + `--append-system-prompt` passed directly | Native flag support; skills survive compaction natively |
| **Codex** | ✅ Yes | ⚠️ Via prompt injection | Prompt injection (skills embedded in prompt text) |
| **OpenCode** | ✅ Yes | ⚠️ Via plugin + prompt injection | Plugin stores system prompt; reinjects on each new conversation or post-compaction |
| **Cursor** | ✅ Yes | ⚠️ To be validated | TBD |

**Key Points:**
- `--system-prompt` and `--append-system-prompt` are **transparent pass-through for Claude** (user-customizable via CLI flags)
- **Codex:** System prompt content is injected into the prompt text itself (no native flag support)
- **OpenCode:** Designed plugin that:
  - Stores `--system-prompt` and `--append-system-prompt` content in space state
  - Reinjects the content at the start of each new conversation (new session or post-compaction)
  - Ensures skills persist across context compaction within the same space
- Skills defined in agent profiles are **always loaded and embedded** (via flags for Claude, via injection for others)

**Primary agent capabilities are identical across harnesses.** Only the delivery mechanism for system prompts varies.

- `space start` launches the primary agent (any harness) with skills embedded + optional custom system prompt.
- `space spawn` and `run create` launch child agents with independent skill sets.
- No Claude-only role constraint: all harnesses follow the same primary/child model.

### Spawned Agents (via `meridian run create`)

Agents spawned by primary or child agents use harness-agnostic `_run_prepare.py` and work across all harnesses:
- ✅ **Claude:** Skills + custom system prompt injected via flags
- ✅ **Codex:** Skills + custom system prompt injected via prompt composition
- ✅ **OpenCode:** Skills injected via prompt injection; custom system prompt handled by plugin
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
✅ Get their own independent skill sets from their profile
✅ No merging with space skills
✅ No CLI skill configuration needed (profile owns skills)
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
| `launch.py:156-183` | Already composes system prompt. We extend to: (1) load agent profile, (2) retrieve `--system-prompt` and `--append-system-prompt` from space state, (3) pass flags directly for Claude or inject for Codex/OpenCode. |
| `SkillRegistry` | Already loads skill files. Reuse as-is. |
| `space` table (SQLite) | Already stores space metadata. We add `agent_type TEXT` (which profile), `custom_system_prompt TEXT`, and `custom_append_system_prompt TEXT` (for Codex/OpenCode reinjection). |
| `runs` table (SQLite) | Already tracks runs/agents. No changes needed. |
| `pinned_files` table (SQLite) | Already tracks pinned context. We reuse as-is for space file management. |
| `context.py:inject_pinned_context()` | Already injects pinned files into prompts. We extend to: (1) include custom system prompt from space state (Codex/OpenCode), (2) skip missing files with warning (vs hard error). |
| `space_lock_path()` + `cleanup_orphaned_locks()` | Already exists for space locking. We reuse for concurrent write protection. |

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
- [ ] Verify `spaces` table has: `id`, `name`, `agent_type`, `primary_session_id`, `status`, `created_at`
- [ ] Add `agent_type TEXT` column if missing (which agent profile this space uses)
- [ ] Add `custom_system_prompt TEXT` and `custom_append_system_prompt TEXT` columns to store user-provided system prompts (for Codex/OpenCode reinjection)
- [ ] Verify `runs` table links runs to spaces via `space_id` (it does)

**Code Changes (lib/ modules):**
- [ ] Update `lib/space/launch.py`:
  - Load agent profile (defines skills)
  - Retrieve custom `--system-prompt` and `--append-system-prompt` from space state
  - **Claude:** Pass flags directly to harness: `--system-prompt <content> --append-system-prompt <content>`
  - **Codex/OpenCode:** Inject skill content + custom system prompt into prompt text
  - Load agent with that profile
  - Harness selection agnostic (any harness can be primary)
- [ ] Update `lib/space/context.py`:
  - Skip missing pinned files with warning (not hard error)
  - Include custom system prompt content in injected context (for Codex/OpenCode)
- [ ] Implement space-level locking in `lib/ops/space.py`: `try_acquire_lock()` with timeout + PID-based cleanup
- [ ] Create `.opencode/plugins/space-system-prompt-injector.ts`:
  - Hook: on each new conversation or post-compaction resumption
  - Read stored custom system prompt from space state
  - Reinject into conversation start (same pattern as orchestrate.ts)

**CLI Commands (in space.py):**
- [ ] Enhance `meridian space start --name <name> --agent <agent> [--system-prompt <text>] [--append-system-prompt <text>]`
- [ ] Enhance `meridian space resume --space-id <id> [--system-prompt <text>] [--append-system-prompt <text>]`
- [ ] Enhance `meridian space show <id>` to display primary agent type + session ID
- [ ] **Remove entirely:** `--skills` flag from all space commands
- [ ] Verify `meridian space list`, `close` still work (already exist)

**Testing:**
- [ ] Claude: Create space with custom `--system-prompt` → verify flag passed to harness
- [ ] Codex/OpenCode: Create space → verify custom system prompt injected in prompt
- [ ] Resume space after context compaction → verify skills + custom prompt reloaded
- [ ] Spawn child agents (via `run create --agent <type>`) → verify independent skill sets
- [ ] Missing pinned file on resume → verify warning (not error)
- [ ] Test with different agent types (researcher, coder, orchestrator) → verify each loads correct skills
- [ ] Verify `--skills` CLI flag is completely removed and CLI fails if user tries to use it

**Documentation:**
- [ ] Update docs: agent profiles define skills, not spaces
- [ ] Document `--system-prompt` and `--append-system-prompt` flags for space start/resume
- [ ] Add example: creating space with custom system prompt and different agent types
- [ ] Document how users customize skills (edit agent profile)
- [ ] Document OpenCode plugin behavior: automatic system prompt reinjection

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
