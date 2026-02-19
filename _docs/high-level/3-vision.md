---
title: Vision Document
description: Where Meridian is heading - agents, marketplace, publishing
created_at: 2025-10-30
updated_at: 2026-02-05
author: Jimmy Yao
category: high-level
tracked: true
---

# Meridian: Vision

## Core Thesis

**"Agentic coding" (like Claude Code, Cursor) revolutionized software development. The same patterns will transform creative writing.**

### The Agentic Pattern

**Agentic Coding:**
- AI explores codebase autonomously
- AI suggests edits across multiple files
- Developer reviews and approves
- Iterative refinement until code works

**Agentic Writing:**
- AI explores creative project autonomously
- AI suggests edits across multiple documents
- Writer reviews and approves
- Iterative refinement until story works

**The pattern:** AI handles structure, consistency, and drafting. Human provides creative vision and final approval.

**We're building this infrastructure for creative writing.**

---

## The Agent Framework Vision

### Why Agents Matter

> "One agent mapping relationships, one helping with the current chapter, one for a random conversation I wanted to have." - User feedback

This is **generic productivity value** (not fiction-specific), delivered through a writer-first UI.

### Key Capabilities (Planned)

#### Parallel Specialized Work

**Thread Branching** - Independent work streams running simultaneously:

```
Session: "My Fantasy Novel"
├─ Thread A (root): Story development conversation
├─ Thread B (branch): "What if" exploration from Turn 12
└─ Thread C (subagent): Character consistency check (spawned by A)

All three share the same .session/ workspace
```

**Use cases:**
- Work on multiple chapters simultaneously
- Explore alternative plot directions
- Run background research while writing
- Delegate fact-checking to subagent

#### Subagents - Delegated Subtasks

**AI spawns specialized workers:**

```
You: "Check this chapter for consistency across the entire series"

Main Agent:
├─ Spawns subagent with task: "Search all chapters for character mentions"
├─ Spawns subagent with task: "Analyze timeline consistency"
└─ Waits for results -> synthesizes -> responds

You see: Collapsed blocks in main thread, expandable to view subagent work
```

**Benefits:**
- Parallel work (faster results)
- Specialized focus (better results)
- Transparent delegation (you can inspect what subagents did)

#### Shared Session Artifacts

**`.session/` directory** - Scratch space shared by all threads in a session:

```
.session/
├─ character_timeline.md     (built by research thread)
├─ plot_analysis.md          (built by planning thread)
└─ consistency_issues.md     (built by critique thread)

All threads can read and write these shared artifacts
```

**Enables:**
- Agent-to-agent handoff via files
- Persistent intermediate work
- Coordination across parallel threads

### Skills, Personas, and Agents

**Skills** - Instruction bundles (system prompt modules):
- Project-owned instances in `.meridian/skills/`
- Full-screen markdown editor
- AI-editable with approval flows
- Sharable between users (import/export)

**Personas** - User-facing master agents:
- **Persona = Model + Reasoning + System Prompt + Skills + Available Agents**
- Examples: "Planner", "Editor", "Brainstorm", "Research"
- User-defined personas (you can create custom personas)
- Single dropdown replaces model + reasoning + system prompt controls

**Agents** - Task-specific workers:
- **Agent = Skills + Tools** (for specific delegated tasks)
- Examples: "Explore" agent, "Edit Plan" agent, "Lint" agent
- Not directly user-selectable - orchestrated by Personas
- Built-in only (v1)

**How it works together:**

```
You select: "Editor" Persona
           ↓
Persona can spawn: ["Explore", "Lint", "Fact-Check"] agents
           ↓
During conversation, Persona decides: "I need to check facts"
           ↓
Spawns: "Fact-Check" agent with specific tools + skills
           ↓
Agent completes -> result flows back to Persona -> Persona responds to you
```

### Prerequisites

Before shipping the agent framework:

| Prerequisite | Why |
|--------------|-----|
| **PAYG billing** | Users pay for LLM usage. Can't ship subagents without it. |
| **Usage limits + budgets** | Prevent runaway cost/latency (especially async subagents). |
| **Audit/debug trace** | Make agent behavior explainable + reversible. |
| **Sessions + `.session/`** | Shared persistent artifacts across thread family. |

**For full design details**, see [`_docs/plans/agents/agents.md`](../plans/agents/agents.md).

---

## The Marketplace Vision

### Skill Sharing

**Create -> Use -> Share lifecycle:**

```
Create (via UI editor or AI)
        ↓
Use (in your project, versioned, AI-editable with approval)
        ↓
Share (import/export between users - v1)
        ↓
Discover (public marketplace - future)
```

**v1 (Ship gate):**
- Import/export skills between users
- Personal skill library
- Project-owned instances (copies)

**Future:**
- Public skill discovery/marketplace
- Ratings and reviews
- Community-curated collections

### Template Projects

**Pre-configured project templates:**
- Genre-specific setups (fantasy novel, screenplay, game design)
- Starter skills and folder structures
- Sample documents showing patterns
- Shareable starter kits

**Examples:**
- "Epic Fantasy Novel" - Character templates, world-building docs, chapter structure
- "Web Serial" - Volume/Arc/Chapter hierarchy, posting schedule tracker
- "Game Design" - NPCs, items, quests, mechanics folders

---

## The Publishing Vision

### Direct Publishing Integration

**Royal Road integration** (priority 1):
- One-click chapter publishing
- Sync published chapters with local documents
- Version control for published content
- Update tracking (local edits -> pending sync status)

**Other platforms:**
- Wattpad, Webnovel, Scribble Hub, etc.
- Platform-specific formatting rules
- Automated metadata (tags, genre, content warnings)

### Export Formats

**EPUB generation:**
- Convert project to publication-ready EPUB
- Respect formatting (italics, bold, scene breaks)
- Table of contents from chapter structure
- Cover art integration

**PDF with formatting:**
- Print-ready manuscript format
- Standard manuscript styles (Shunn, etc.)
- Custom formatting options

**Platform-specific exports:**
- Royal Road markdown
- Wattpad HTML
- Standard manuscript format (.docx)

---

## Other Future Directions

### Multi-Document Batch Editing

**One creative direction -> many document updates:**

```
You: "Make Elara more cynical"

AI updates atomically:
├─ Characters/Elara.md (personality)
├─ Chapter 1 (dialogue)
├─ Chapter 5 (inner monologue)
├─ Chapter 12 (reaction to betrayal)
└─ Characters/Marcus.md (relationship notes)

You: Review all 5 changes
├─ Accept all -> atomic commit
├─ Accept some -> selective application
└─ Refine -> AI iterates
```

**Like git commits for creative work.**

### Advanced Context Discovery

**Beyond full-text search:**
- RAG with embeddings (semantic search)
- Better entity extraction (understand "she" = "Elara")
- Learning from usage patterns
- Context ranking improvements

**Current MVP uses full-text search** - good enough to validate. These improvements come later.

### Proactive AI Behaviors

**AI notices issues and suggests fixes:**

- **Consistency monitoring** - "Her eyes were blue in Ch 1, green in Ch 5"
- **Missing documentation** - "You mention 'The Council' in 3 chapters but have no lore doc"
- **Context optimization** - "Add Characters/Elara as reference to this chapter"
- **Stale content alerts** - "This chapter contradicts updated character wiki"

**All suggestions require user approval** - AI never modifies without permission.

### Compaction

**Long conversations stay usable:**
- Summary turns for long threads
- AI context starts from most recent compaction
- Old turns still searchable via tool
- Configurable summarization model

---

## Market Discovery

### Starting Hypothesis: Fiction Writers

**Why test with fiction first:**
- Direct access (Royal Road audience)
- Personal pain point (founder is a writer)
- Clear use case to validate
- Fast feedback loop

**But this is a hypothesis, not a commitment.**

If fiction writers don't convert but game developers do -> pivot to game dev.
If neither works but technical writers love it -> pivot to docs.
If enterprise product teams want it -> pivot to B2B.

**We're optimizing for learning, not a specific market.**

### Potential Markets (Ordered by Validation Speed)

**1. Fiction Writers** (fastest to validate)
- 100+ chapters, lose track of details
- ChatGPT forgets everything
- Manual search through old chapters

**2. Game Developers** (high potential)
- Hundreds of NPCs, items, mechanics
- Spreadsheets everywhere
- No good documentation tools

**3. Technical Writers** (B2B potential)
- API docs across multiple products
- Manual cross-referencing
- Version confusion

**And more markets to discover...**

---

## Core Principles (What Doesn't Change)

These principles guide every decision, regardless of which market we serve:

### 1. Documents, Not Files

Clean, natural document names. No extensions.

```
✓ Elara
✓ Chapter 1
✓ Combat System

✗ elara.md
✗ chapter_01.txt
✗ combat_system.doc
```

### 2. AI Assists, Humans Decide

AI suggests, users approve. Always visible, always controllable, always overrideable.

### 3. Privacy and Ownership First

BYOK option (future). Easy export. Encrypted keys. No lock-in.

### 4. Multi-Provider by Default

Support multiple AI providers. Make adding new ones easy. Let users choose.

### 5. Performance Matters

Zero lag. Instant switching. Smooth streaming. Fast search.

### 6. Persistent Streaming

AI continues working server-side even if user disconnects.

---

## Implementation Priority

**Phase 0: Foundations** (Independent tasks)
- PAYG billing
- Usage metering + limits
- Audit/debug trace
- Sessions + `.session/`

**Phase 1: Skills**
- `.meridian/skills/` instance handling
- Skill loading pipeline
- User skill library
- Skill CRUD tools (for AI to create/edit skills)
- Import/export (cross-user sharing)

**Phase 2: Personas**
- Persona data model + CRUD
- Pre-made personas (Planner, Editor, Brainstorm)
- User-defined persona creation UI
- Persona selector (replaces model + reasoning dropdowns)

**Phase 3: Agents**
- Built-in agent definitions
- Agent composition (prompt + skills + tools)
- Persona -> Agent spawning

**Phase 4: Subagents**
- `spawn_agent` tool
- Child thread creation
- Subagent streaming + result return
- Depth limit enforcement

**Phase 5: Compaction**
- Compaction turn creation
- `conversation_search` tool
- Auto-compact + model selection

**For detailed implementation phases**, see [`_docs/plans/agents/agents.md`](../plans/agents/agents.md).

---

## Success Metrics

**Discovery mindset** - Follow the strongest signal. Build what people will pay for.

**For fiction:**
- Do they use it regularly?
- Does context discovery work?
- Do they value the AI assistance?
- Will they pay?

**For other markets:**
- Different metrics
- Different value props
- Test and learn

---

## The Opportunity

**Creative documentation is universal.** Fiction writing is just the wedge:

- $10B+ fiction market
- Exploding web serial growth
- No good tools exist
- Pattern applies to game dev, screenwriting, docs, product specs

**AI that automatically understands your entire project by reading what you write is valuable.**

**Where it's most valuable is what we're discovering.**

**Stay flexible. Follow the strongest signal.**
