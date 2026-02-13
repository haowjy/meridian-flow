# Agent Framework: High-Level Design

> **Purpose**: Orchestration document for the full agent framework. Use to spawn smaller, specific implementation plans.
>
> **Status**: Design exploration complete. Breaking changes OK (no users yet). No code execution initially.
>
> **Scope**: Post-MVP. MVP (single agent chat) is complete. This framework is the next major evolution.

---

## Core Value Proposition

**Parallel specialized work** - Users want multiple agents running simultaneously on different tasks:

> "One agent mapping relationships, one helping with the current chapter, one for a random conversation I wanted to have."

This is generic productivity value (not fiction-specific), delivered through a writer-first UI.

| Pattern | Mechanism | Primary Use |
|---------|-----------|-------------|
| **Parallel threads** | User-initiated branching | Independent work streams (core value) |
| **Subagents** | LLM-initiated spawning | Delegated subtasks |
| **Shared session** | `.session/` artifacts | Coordination between threads |

**Key insight**: Thread branching (parallel independent work) is as important as subagent spawning (delegated subtasks).

---

## Prerequisites

| Prerequisite | Why | Scope |
|--------------|-----|-------|
| **PAYG Billing** | Users pay for LLM usage. Can't ship subagents without it. | All LLM usage (not just subagents) |
| **Usage limits + budgets** | Prevent runaway cost/latency (esp. async subagents). | Per user/project/session |
| **Audit/debug trace** | Make agent behavior explainable + reversible. | Turns, tools, skills, models |
| **Chat → Thread rename** | Align naming with async, branchable conversation graph. | Backend + frontend + API |
| **Sessions (+ `.session/`)** | Shared persistent artifacts across thread family. | Backend + frontend + tools |
| **Collab core (Specs + Phases 1-3)** | Agent writes must use canonical op-log/proposal model, not legacy `ai_version` CAS. | `_docs/plans/fb-realtime-collab-editing.md` + `_docs/plans/collab-ai/spec/` + `_docs/plans/collab-ai/phase/` |
| **No BYOK (v1)** | Simplifies billing. One payment flow. | Revisit post-v1 |

---

## Independent Tasks (Product-Wide)

These can be implemented/shipped independently at any time (not inherently “agentic”), and they improve the product as a whole.

| Task | Outcome | Notes |
|------|---------|-------|
| **Usage metering** | Persist tokens + estimated cost per turn/run. | Uses existing token columns; add pricing + aggregation. |
| **Usage & limits page** | Users can view usage and set caps (tokens/$/time/concurrency). | Settings UI + clear error surfaces. |
| **Limits enforcement** | Server-enforced budgets + timeouts + concurrency limits. | Apply to *all* LLM runs. |
| **PAYG billing** | Charge for LLM usage. | Requires metering + enforcement to be meaningful. |

---

## Independent Tasks (Agent Framework Foundation)

These are “agent framework” tasks that still stand alone (they improve correctness, UX, and future extensibility even before subagents).

| Task | Outcome | Notes |
|------|---------|-------|
| **Chat → Thread rename** | Naming matches async/thread graph semantics. | Prefer scoped rename (avoid “thread-safe” collisions). |
| **Sessions (+ `.session/`)** | Shared persistent artifacts across thread family. | Includes persistence + tools + dedicated UI surface. |
| **Thread modes (Plan/Edit)** | Server-enforced write gating for workspace vs session. | Mode must be enforced at the tool layer (not just UI). |
| **Audit/debug trace** | “Why did it do that?” is answerable. | Persist prompt manifest + tool traces + provenance. |

---

## Independent Tasks (Other)

These are valuable standalone improvements that can ship without committing to the full agent framework.

| Task | Outcome | Notes |
|------|---------|-------|
| **Compaction** | Long threads stay usable (summaries, pinned constraints). | Can ship without sessions/subagents. |
| **Conversation search** | Search turns/blocks + jump-to-turn. | Useful as UI and as an agent tool later. |
| **Turn debug drawer** | Inspect model/tokens/stop_reason/tool calls/errors. | Can start as “surface existing fields”. |
| **Streaming cancel + retry UX** | Reliable stop/regenerate semantics. | Improves writer trust + reduces frustration. |
| **Model catalog UI** | Per-project defaults and capability-aware selection. | Builds on existing model metadata. |
| **Tool permissions UI** | Explicit per-project/per-thread tool enablement. | Supports safer rollout of more tools. |
| **Skill editor UI** | Dedicated skill editing surface with diff/rollback. | Complements skill revision policy. |
| **Promote output to document** | Save/append AI output into workspace documents. | Immediate writer-first value. |
| **Rate limiting / abuse controls** | Prevent runaway usage even pre-PAYG. | Complements limits/budgets enforcement. |
| **SSE resilience** | Better reconnect/resume and clearer statuses. | Improves reliability for all LLM usage. |

---

## Core Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         PROJECT                              │
│  ┌────────────────┐  ┌────────────────┐  ┌───────────────┐  │
│  │   Documents    │  │  .meridian/**  │  │   .session/   │  │
│  │  (workspace)   │  │ (Meridian-owned│  │  (mounted,    │  │
│  │                │  │  project state)│  │ thread-owned) │  │
│  └────────────────┘  └────────────────┘  └───────────────┘  │
└─────────────────────────────────────────────────────────────┘
           │                    │                   │
           ▼                    ▼                   ▼
┌─────────────────────────────────────────────────────────────┐
│                         SESSION                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  SessionDocuments (.session/*)                       │    │
│  └─────────────────────────────────────────────────────┘    │
│                            │                                 │
│    ┌───────────────────────┼───────────────────────┐        │
│    │                       │                       │        │
│    ▼                       ▼                       ▼        │
│ ┌──────────┐         ┌──────────┐          ┌──────────┐    │
│ │ Thread A │         │ Thread B │          │ Thread C │    │
│ │ (root)   │         │ (branch) │          │ (subagent│    │
│ └──────────┘         └──────────┘          │ of A)    │    │
│      │                    │                └──────────┘    │
│      │                    │                     ▲          │
│      │                    └─ branched_from_turn_id         │
│      └─────────────────────────────────────────────────────│
│              All threads share same Session                 │
└─────────────────────────────────────────────────────────────┘
```

**Key insight**: Session is the container. Multiple root threads can exist (via branching), plus subagents (via spawning).

---

## Key Concepts

### Thread (renamed from Chat)
- Conversation session with LLM
- Access to project workspace + shared session
- Can operate in **Plan Mode** (read-only) or **Edit Mode** (full access)
- Can spawn subagents

### Session
- Shared scratch space for thread family
- LLM sees `.session/` virtual path
- Mounted per `session_id` (not stored under `.meridian/**` in the project tree)
- AI can create files/folders in `.session/**` via the same tool surface
- Enables agent-to-agent handoff via files
- **Lifecycle**: Persistent working state. Agents discover `.session/` fresh each conversation unless they have prior context. Deleted when all threads in session are deleted (cascade).

### Meridian-owned Project State (`.meridian/**`)

`.meridian/**` is reserved for Meridian-owned project state (skills/personas/agents instances, manifests, etc.). It must be:
- **Hidden from the writer file tree UI** (always)
- **Gated from LLM tools by default** (not discoverable via `doc_tree`/`doc_search`, not editable via `doc_edit` unless explicitly enabled)
- **Editable only through dedicated UIs** (Skill Editor, Persona Editor, etc.) and explicit approval flows

Runtime behavior:
- Prompt resolver / agent runner loads only the specific configured instances it needs (e.g., the project’s selected skills), not “scan all of `.meridian/**`”.

### Subagent
- Child thread with `parent_thread_id`
- Shares parent's `session_id`
- Spawned via `spawn_agent` tool
- Result flows back as tool_result

### Skills
- Instruction bundles as project-owned instances under `.meridian/skills/**`
- SKILL.md with frontmatter (name, description) + instructions
- Instance folder names are human-facing project-unique names (not slugs). Stability comes from IDs stored in metadata (e.g., `meta.json` inside the instance folder).
- Progressive loading: metadata → instructions → resources
- Edited via dedicated UI (not exposed as a normal folder in the writer file tree)
- **Skills ARE the system prompt** (in modular, composable pieces)
- Versioned + auditable (every change creates a new revision; active revision is a pointer)
- AI-editable behavior is configurable (see Skill Editing Policy)
- **Sharable**: Import/export between users (v1)
- **Discoverable**: Public sharing marketplace (deferred, on roadmap)
- **Meta-skill pattern**: A "skill-creator" skill can teach the LLM to create new skills following conventions

### Personas (User-Facing)
- **Persona = Model + Reasoning + System Prompt + Skills + Available Agents**
- The high-level "master agent" that users select and interact with
- Bundles all configuration into a single selectable entity
- Examples: "Planner", "Editor", "Brainstorm", "Research"
- **User-defined personas (v1)** - users can create custom personas
- **Pre-made personas** - ship with sensible defaults for common writing tasks
- UI: Single dropdown replaces model + reasoning + system prompt controls
- Personas can specify which agents they're allowed to spawn

### Agents (Task-Specific)
- **Agent = Skills + Tools** (for a specific delegated task)
- Task-specific workers that Personas delegate to via `spawn_agent`
- Not directly user-selectable - orchestrated by the Persona
- Examples: "Explore" agent, "Edit Plan" agent, "Lint" agent
- **Built-in agents only (v1)** - code-defined, fixed tool sets
- Can override model (e.g., faster model for simple tasks)
- User-defined agents deferred until custom tools exist

### Persona vs Agent Distinction

| Aspect | Persona | Agent |
|--------|---------|-------|
| **Who selects it** | User (via UI dropdown) | Persona (via `spawn_agent`) |
| **Role** | Master coordinator | Task-specific worker |
| **Scope** | Full conversation | Single delegated task |
| **Configuration** | Model, reasoning, system prompt, skills, available agents | Skills, tools, model override |
| **User-defined** | Yes (v1) | Deferred |

### Compaction
- Summary turn for long conversations
- LLM context starts from most recent compaction
- Old turns still searchable via tool
- Configurable model (optimize for summarization)

---

## Data Model Overview

```
Session
├── id, project_id, created_at
└── SessionDocuments[]

Thread (formerly Chat)
├── id, project_id, user_id
├── session_id            ← shared by thread family
├── parent_thread_id      ← NULL for roots, set for subagents
├── branched_from_turn_id ← NULL for fresh, turn_id for branch point
├── agent_type            ← NULL for user threads, slug for agents
└── Turns[]

Turn
├── ...existing fields...
├── is_compaction       ← marks as summary turn
└── Blocks[]

Persona (user-defined)
├── id, user_id, project_id (nullable for global)
├── slug, name, description
├── model_id, reasoning_level
├── system_prompt
├── skills[]                  ← skills to load
├── available_agents[]        ← agents this persona can spawn
└── is_default               ← default persona for new threads

Agent (built-in, v1)
├── slug, name, system_prompt
├── skills[], tools[]
└── model (optional override)
```

---

## User Library Pattern

Skills follow a create → use → share lifecycle:

```
Create (UI editor OR LLM via "skill-creator" meta-skill)
        ↓
Use (per-project instance in .meridian/skills/, versioned, AI-editable with approval flow)
        ↓
Share (import/export between users - v1)
        ↓
Discover (public sharing marketplace - deferred)
```

**Shared-project constraint**: projects must only load skills/personas/agents from **project-owned instances** (copies) to keep runtime deterministic and collaborator-safe. See:
- `_docs/plans/fb-artifact-templates-and-project-instances.md`

| Type | User Library | Project Level | Sharing | Status |
|------|-------------|---------------|---------|--------|
| Personas | Database (user-defined) | Per-thread selection | Import/export (v1) | v1 |
| Skills | Database | `.meridian/skills/` instances (LLM-editable) | Import/export (v1), public (later) | v1 |
| Agents | — | Built-in only | — | v1 (user-defined deferred) |
| Tools | — | Built-in only | — | v1 (custom tools deferred) |

**Rationale**: Personas are user-defined (v1) because they're purely configuration bundles. Custom agents need custom tools to be useful - defer both until there's a clear need.

---

## Skill Editing Policy

Skills are high-leverage configuration (they compile into the system prompt), so skill edits must be:
(1) versioned, (2) attributable, and (3) reversible.

### Revision Model

- Every change creates a new `SkillRevision` (immutable).
- Each skill has an `active_revision_id` pointer (rollback = pointer move).
- Each revision records provenance: `source=user|ai`, `thread_id`, `agent_type`, `model`, `created_at` (and optional `reason`).

### AI Skill Editing Settings

| Setting | AI Write Behavior | User Approval | Notes |
|--------|-------------------|--------------|------|
| Manual | Writes a draft revision only | Required to activate | Most controlled |
| Auto (safe-only) | Auto-activates safe revisions | Required for privilege/policy changes | Default recommendation |
| Auto (all) | Auto-activates all revisions | Not required | Power-user mode |

**Privilege/policy changes** (gate in `Auto (safe-only)`):
- Any change that alters enabled tools/tool params, or changes an agent’s tool set
- Any change to Plan/Edit enforcement rules
- Any change to pinned “Core Policy” skill(s)
- Any change that modifies skill trust settings / auto-apply configuration

**Loader rule**: threads load the skill’s `active_revision_id` by default. Draft revisions are only loaded in explicit preview modes.

---

## Thread Modes

| Mode | Workspace Write | Session Write | Use Case |
|------|-----------------|---------------|----------|
| Plan | ❌ | ✅ | Research, planning |
| Edit | ✅ | ✅ | Making changes |

---

## Thread Branching

Users can branch off a conversation to create a **new parallel thread** (distinct from subagents).

| Aspect | Subagent | Branch |
|--------|----------|--------|
| Created by | `spawn_agent` tool (LLM) | User action (UI) |
| Lifecycle | Tied to parent, result flows back | Independent, runs parallel |
| Context | Fresh start with task prompt | Optional: inherit up to branch point |
| Use case | Delegate subtask | Parallel exploration, "what if" |

**UI**: Branched threads appear connected (e.g., tree view, visual connector) to show relationship.

**Data**: `branched_from_turn_id` tracks the branch point (or NULL for fresh branch).

---

## Concurrency Model

Multiple threads (branches or subagents) may target the same files. Resolution must follow the canonical collaboration model: **authoritative applied op-log + non-authoritative proposals**.

```
Agent reads base_version + content context
Agent proposes edit against base_version
Acceptance path rebases proposal against current head
High-overlap/conflict? -> mark conflicted, require regenerate/review
```

**Tool contract**:
- Agents do **not** write authoritative document ops directly.
- Agents produce proposals tied to a known `base_version`.
- Server-side accept/reject is the authority gate and is serialized per document.

| Scenario | Behavior |
|----------|----------|
| Agent A and Agent B propose overlapping edits | Both can be created; acceptance order + conflict policy determines outcome |
| Agent proposes from stale base | Rebase attempt on accept; if unsafe, proposal marked `conflicted` |
| User edits while agent proposal is pending | Proposal is remapped/rebased at accept time or marked `conflicted` |

Reference:
- `_docs/plans/fb-realtime-collab-editing.md`
- `_docs/plans/collab-ai/phase/phase-3-ai-proposals-and-review.md`
- `_docs/plans/collab-ai/phase/phase-4-multi-agent-arbitration.md`

---

## Subagent Flow

```
Parent Thread                     Child Thread (Subagent)
─────────────                     ───────────────────────
Turn: streaming
    │
    ├── tool_use: spawn_agent
    │
Turn: waiting_subagents ─────────► Thread created
                                   Turn: streaming
                                       │
                                   (works, uses tools)
                                       │
                                   Turn: complete
    │                    ◄─────────result
    ├── tool_result
    │
Turn: streaming (continues)
    │
Turn: complete
```

---

## Implementation Phases

### Phase 0: Foundations (Independent)
- Implement “Independent Tasks (Product-Wide)” and/or “Independent Tasks (Agent Framework Foundation)” as desired

### Phase 1: Skills
- `.meridian/skills/` instance folder handling
- Skill loading pipeline
- User skill library
- Skill CRUD tools (for LLM to create/edit skills via meta-skill pattern)
- Skill import/export (cross-user sharing)

### Phase 2: Personas
- Persona data model + CRUD
- Pre-made personas (Planner, Editor, Brainstorm, etc.)
- User-defined persona creation UI
- Persona selector (replaces model + reasoning dropdowns in thread input)
- Thread ↔ Persona association (persist selected persona per thread)

### Phase 3: Agents
- Built-in agent definitions (code-defined)
- Agent composition (prompt + skills + built-in tools)
- Persona → Agent spawning (persona specifies available agents)

### Phase 4: Subagents
- `spawn_agent` tool
- Child thread creation
- Subagent streaming + result return
- Depth limit enforcement (setting, default=1)
- **Ship gate**: complete the "Prerequisites" section (billing + limits/budgets + audit + sessions + thread naming + collab core phases 1-3)

### Phase 5: Compaction
- Compaction turn creation
- Message builder updates
- `conversation_search` tool
- Auto-compact + model selection

---

## What's Already Good

- Tool registry Builder pattern ✓
- `waiting_subagents` status in schema ✓
- Streaming/SSE infrastructure ✓
- Turn tree structure ✓
- Clean architecture (SOLID) ✓
- Provider abstraction ✓

---

## Resolved Questions

| Question | Resolution |
|----------|------------|
| **Concurrency** | Canonical collab contract: agents propose against `base_version`; server-serialized accept/rebase applies authoritative ops. Unsafe overlap -> `conflicted`. |
| **Session cleanup** | Persistent working state, discovered fresh each conversation. Cascade delete with threads. |
| **Lifecycle** | Session deleted when all threads deleted. |
| **Subagent depth** | Configurable in settings, default = 1 (subagents cannot spawn subagents). Prevents runaway costs and infinite loops. Requires PAYG billing. |
| **Subagent UI** | Inline collapsed block, expandable to see subagent's thinking/progress. Alternative: popup modal. (It's a full thread, should be viewable.) |
| **Branch modes** | Two types: (1) Branch from turn → copies turns up to that point, (2) Branch with session only → no turn history, just `.session/` access. No "summary" mode for now. |
| **User-defined agents/tools** | Deferred. Custom agents need custom tools to be useful. Built-in only for v1. |

---

## Exports (Project + Sessions)

When exporting an entire project, include *both* project files and conversation/session data. Keep namespaces separate so they’re easy to reason about and don’t collide with writer content.

| Export root | Contains | Notes |
|---|---|---|
| `workspace/**` | Writer-visible project files | Equivalent to “project root” content |
| `.meridian/**` | Meridian-owned project state | Skill/persona/agent instances, manifests, etc. |
| `sessions/<session_id>/threads/**` | Thread/turn history | Prefer JSON; optional MD rendering |
| `sessions/<session_id>/session_fs/**` | Snapshot of mounted `.session/**` | Copy at export time; `.session/**` remains virtual at runtime |

---

## Open Questions (Deferred)

1. **Branch UI** - How to visualize thread relationships? Tree view? Tabs with connectors? (Decide during implementation)

---

## Future Scope (Not Now)

- Custom tools (code execution, API calls, etc.)
- User-defined agents (requires custom tools first)
- **Public skill discovery/marketplace** (import/export is v1; public sharing is deferred)
- Advanced agent orchestration patterns
- BYOK (Bring Your Own API Key)
