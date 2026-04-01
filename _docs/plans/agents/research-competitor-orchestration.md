# Agent Orchestration: Competitor & Adjacent Product Research

> **Purpose**: Comprehensive competitive analysis of how products handle agent orchestration, multi-agent workflows, and work session management — compared with Meridian's spawns-as-threads, file-first agent profiles, and work sessions with shared FS.
>
> **Date**: 2026-03-23
> **Status**: Research complete

---

## Meridian's Approach (Baseline)

For comparison context, Meridian's planned agent framework uses:

| Concept | Meridian's Design |
|---------|------------------|
| **Spawn model** | Spawns-as-threads (child thread with `parent_thread_id`, shares `session_id`) |
| **Agent profiles** | File-first: markdown with YAML frontmatter in `.claude/agents/` (via Claude Code) or built-in code-defined (v1) |
| **Work sessions** | Shared `.session/` filesystem — virtual mount visible to all threads in a session |
| **Coordination** | File-based handoff via `.session/` artifacts |
| **Isolation** | Shared session FS for coordination; CAS concurrency for document writes |
| **Visibility** | Personas = user-selectable, Agents = spawnable-only (not user-visible) |
| **Result flow** | Subagent result flows back as `tool_result` to parent thread |

---

## 1. Writing / Creative AI Platforms

### Sudowrite

**Approach**: Monolithic single-agent with specialized "modes" (Write, Describe, Rewrite, Brainstorm). No multi-agent orchestration. AI operates as a single context with mode-switching rather than spawning workers.

- **Agent profiles**: None. Fixed built-in modes with different prompt strategies
- **Work sessions**: Single document context with some project awareness
- **Coordination**: N/A — single agent, sequential operations

**Pros vs Meridian**: Simpler UX; writers don't need to understand agent concepts
**Cons vs Meridian**: No parallelism, no specialization, no autonomous multi-step workflows
**Steal**: Their mode-based UX is clean — Meridian's Persona selector should be equally frictionless

### NovelCrafter

**Approach**: Structured data-first with BYOK AI. The **Codex** (story bible) is the coordination mechanism — characters, locations, lore entries are structured data that gets injected into AI context automatically when referenced.

- **Agent profiles**: None — uses configurable AI "presets" (model + prompt templates)
- **Work sessions**: Scene-based writing with automatic Codex injection
- **Coordination**: Codex entries auto-linked when detected in prompts — the structured data IS the shared context
- **Multi-agent**: None. Single AI call per interaction

**Pros vs Meridian**: Codex auto-linking is elegant — structured data provides precise, curated context without manual selection. BYOK model gives users cost control
**Cons vs Meridian**: No agentic behavior, no autonomous exploration, no parallelism
**Steal**: **Codex auto-linking pattern** — Meridian should consider auto-detecting entity references and injecting relevant context automatically, similar to how NovelCrafter links Codex entries. This is more structured than raw doc_search.

### Key Insight — Writing Tools

No writing tool competitor has multi-agent orchestration. They all use single-agent models with either:
- Fixed modes (Sudowrite)
- Structured data injection (NovelCrafter)
- Simple prompt templates (most others)

**Meridian's agent framework would be genuinely novel in this space.** The risk is over-engineering for users who may just want simple mode-switching.

---

## 2. AI Coding Tools

### Claude Code (Direct Ancestor)

**Approach**: Hierarchical agent system with three levels of parallelism:

1. **Subagents** — child agents within a single session, results flow back to parent
2. **Agent Teams** — multiple independent Claude Code instances coordinating via shared task list + direct messaging
3. **Git Worktrees** — physical filesystem isolation for parallel work

| Feature | How It Works |
|---------|-------------|
| **Agent profiles** | Markdown files with YAML frontmatter in `.claude/agents/` (project or user scope) |
| **Frontmatter fields** | `name`, `description`, `tools`, `disallowedTools`, `model`, `permissionMode`, `maxTurns`, `skills`, `memory`, `background`, `isolation`, `hooks`, `mcpServers`, `effort` |
| **Spawning** | Via `Agent` tool; subagents get own context window, custom system prompt, restricted tools |
| **Background execution** | `background: true` — runs concurrently, pre-approves permissions upfront |
| **Isolation** | `isolation: worktree` creates temp git worktree; auto-cleaned if no changes |
| **Memory** | Persistent memory directories (`user`, `project`, `local` scope) for cross-session learning |
| **Agent Teams** | Multiple full Claude Code instances, shared task list with file locking, direct SendMessage between teammates |
| **Coordination** | Teams: shared task file + mailbox. Subagents: result flows as tool_result |
| **Built-in agents** | Explore (Haiku, read-only), Plan (inherits, read-only), General-purpose (all tools) |
| **Nesting** | Subagents cannot spawn other subagents. Agent teams cannot nest teams |

**Pros vs Meridian**:
- Mature file-based agent profile system with extensive frontmatter options
- Worktree isolation is elegant for filesystem-level safety
- Agent Teams provide true peer-to-peer collaboration (not just parent→child)
- Persistent memory directories enable cross-session learning
- Hooks system (PreToolUse, PostToolUse, SubagentStart, SubagentStop) provides lifecycle control

**Cons vs Meridian**:
- No shared persistent session artifacts (teams use task files + SendMessage, not shared FS)
- Agent teams are experimental with known limitations (no session resumption, can't transfer leadership)
- No structured data injection (relies on CLAUDE.md and file reading)
- CLI-native — doesn't translate directly to web UI context

**Steal**:
- **Persistent agent memory** — agents that learn across sessions. Meridian's `.session/` is per-session; consider adding persistent agent memory
- **Permission modes per subagent** — `acceptEdits`, `dontAsk`, `plan` modes give fine-grained control
- **Hooks for lifecycle events** — SubagentStart/SubagentStop hooks for setup/teardown
- **MCP server scoping** — giving specific agents access to specific external tool servers
- **Agent Teams task list with file locking** — robust coordination primitive

### Cursor

**Approach**: IDE-native multi-agent with cloud-isolated execution.

- **Agent architecture**: Composer model (proprietary) + up to 8 parallel agents
- **Agent profiles**: Not file-based — agents are defined by the task they're assigned
- **Isolation**: Each agent runs in its own cloud VM sandbox
- **Background agents**: Run on isolated cloud VMs, results merged back to main branch
- **BugBot**: Automated PR scanning agent that runs independently

**Pros vs Meridian**: Cloud VM isolation is stronger than filesystem isolation; Composer model is optimized for agent interactions (4x speed)
**Cons vs Meridian**: No user-defined agent profiles, no shared session artifacts, cloud-only
**Steal**: **Cloud VM sandboxing** — stronger isolation than worktrees for untrusted operations

### Windsurf (Cascade)

**Approach**: Single persistent context-aware agent with background planning.

- **Architecture**: Cascade engine maintains deep codebase context via RAG + real-time indexing
- **Multi-agent**: Not truly parallel — sequential execution with queued instructions. Max 10 parallel Cascade sessions
- **Planning agent**: Background planning agent continuously refines long-term plan while action agent executes
- **Agent profiles**: None — single Cascade agent with configurable context

**Pros vs Meridian**: Deep automatic context awareness; background planning is clever separation of concerns
**Cons vs Meridian**: No true parallelism, no agent customization
**Steal**: **Background planning agent** — a dedicated planning agent that runs alongside the working agent, continuously refining strategy. Meridian's Plan mode is user-initiated; consider auto-planning.

### Cline

**Approach**: IDE agent with approval-gated execution.

- **Philosophy**: "Approve everything" — every file change and terminal command requires explicit user approval
- **Orchestration**: Single agent loop (ask → plan → approve → execute)
- **Agent profiles**: None — single agent with configurable model and permissions

**Pros vs Meridian**: Maximum user control and safety
**Cons vs Meridian**: No parallelism, approval friction slows autonomous workflows
**Steal**: Nothing novel for multi-agent; Meridian's concurrent agents are more powerful

### Aider

**Approach**: Terminal agent that "thinks in git."

- **Orchestration**: Single agent, every edit = commit, every session = branch
- **Agent profiles**: None
- **Coordination**: Git itself is the coordination mechanism

**Pros vs Meridian**: Git-native workflow makes review/revert trivial
**Cons vs Meridian**: No multi-agent, no parallelism
**Steal**: **Git-as-coordination** — Meridian's CAS concurrency control is similar in spirit; consider making the version history more visible to writers

---

## 3. AI Agent Frameworks

### CrewAI

**Approach**: Role-based team composition with YAML configuration.

| Feature | Implementation |
|---------|---------------|
| **Agent profiles** | YAML files (`agents.yaml`) with `role`, `goal`, `backstory`, plus execution params |
| **Configuration** | `max_iter`, `max_rpm`, `max_execution_time`, `allow_delegation`, `memory`, `reasoning` |
| **Task delegation** | Tasks defined separately with `description`, `expected_output`, `context` (references to prior task outputs) |
| **Process types** | Sequential (pipeline), Hierarchical (manager agent coordinates) |
| **Result aggregation** | Output of one task becomes input context for the next; hierarchical mode has manager synthesize |
| **Memory** | Optional shared memory space for context across agents |

**Pros vs Meridian**:
- YAML-based agent profiles are simple and version-controllable (similar to Meridian's markdown approach)
- Role/goal/backstory is intuitive — maps to how humans think about teamwork
- Allow_delegation flag enables agent-to-agent task passing

**Cons vs Meridian**:
- No real-time streaming or interactive UI
- Agent definitions feel like job postings — less flexible than markdown system prompts
- Sequential/hierarchical only — no true peer-to-peer coordination
- 80% of value is in task design, not agent design — tasks are separate from agent definitions

**Steal**: **Goal + Backstory on agent profiles** — Meridian's Persona concept has `system_prompt` but could benefit from explicit `goal` and `backstory` fields for more structured agent identity

### AutoGen (AG2)

**Approach**: Conversation-based multi-agent orchestration.

| Feature | Implementation |
|---------|---------------|
| **Agent profiles** | Code-defined `ConversableAgent` with `system_message` |
| **Orchestration** | GroupChat: multiple agents in shared conversation, selector picks next speaker |
| **Selector patterns** | AutoPattern (LLM picks), RoundRobin, Random, Manual |
| **Communication** | Direct message passing between agents via conversation |
| **State** | Conversation history IS the shared state (no separate state store in v0.2) |
| **Nesting** | Nested chats for sub-conversations |

**Pros vs Meridian**:
- Conversation-as-coordination is natural and inspectable
- GroupChat with speaker selection is powerful for collaborative reasoning
- Unified GroupChat+Swarm architecture (v0.9) is clean

**Cons vs Meridian**:
- Expensive: every agent turn = full LLM call with accumulated conversation history
- 4-agent debate with 5 rounds = 20+ LLM calls minimum
- No persistent artifacts — conversation history is ephemeral
- Manual state management required

**Steal**: **GroupChat with speaker selection** — for Meridian's collaborative writing scenarios, a group chat where personas debate (e.g., editor vs. fact-checker vs. prose stylist) could be powerful. The selector pattern (LLM-driven, round-robin, manual) is flexible.

### LangGraph

**Approach**: Graph-based state machine with explicit control flow.

| Feature | Implementation |
|---------|---------------|
| **Agent profiles** | Stateless node functions — no personality/identity layer |
| **State management** | Shared `TypedDict` state flows between nodes; built-in checkpointing |
| **Orchestration** | Directed graph with conditional edges and routing functions |
| **Communication** | Agents read/write to shared state dict — never communicate directly |
| **Persistence** | Native checkpointing for state recovery |
| **Cost** | ~2,000 tokens per equivalent task (vs AutoGen's ~8,000) |

**Pros vs Meridian**:
- Most efficient token usage of any framework
- Deterministic execution — graph structure ensures predictable flow
- Built-in state persistence with checkpointing
- Runtime graph mutation allows dynamic adaptation

**Cons vs Meridian**:
- No agent identity/personality — agents are just functions
- Steep learning curve — must think in graph terms
- Inflexible for emergent, conversational collaboration

**Steal**: **Shared typed state with checkpointing** — Meridian's `.session/` is unstructured files; adding structured shared state (like a typed key-value store) alongside files could improve coordination reliability

### Semantic Kernel (Microsoft)

**Approach**: Plugin-based orchestration with multiple patterns.

| Pattern | How It Works |
|---------|-------------|
| **Sequential** | Pipeline: A → B → C, each agent processes and passes output |
| **Concurrent** | Broadcast: all agents get same input, results collected independently |
| **Handoff** | Dynamic routing: agents pass control based on context/rules |
| **Group Chat** | All agents participate in shared conversation with group manager |
| **Magentic** | MagenticOne-inspired generalist multi-agent collaboration |

**Pros vs Meridian**:
- Unified API across all orchestration patterns — swap patterns without rewriting logic
- Plugin architecture makes agents composable
- Combines AutoGen (conversation) + Semantic Kernel (tools/plugins) into single framework

**Cons vs Meridian**:
- Enterprise-focused — complex setup
- No file-based agent definitions

**Steal**: **Unified orchestration API** — Meridian could benefit from a single interface where you can swap between sequential/parallel/group-chat modes for different writing tasks

### OpenAI Agents SDK (Swarm)

**Approach**: Handoff-based agent orchestration with minimal primitives.

| Feature | Implementation |
|---------|---------------|
| **Core primitives** | Agents, Handoffs, Guardrails, Tools |
| **Agent profiles** | Code-defined: `Agent(name, instructions, tools, handoffs)` |
| **Handoff** | Tool call that returns another Agent — runner switches `active_agent` |
| **State** | Shared conversation history maintained by runner |
| **Guardrails** | Input/output validation on agent boundaries |

**Pros vs Meridian**: Minimal, elegant design — handoff is just a tool call that returns an agent
**Cons vs Meridian**: Stateless (Swarm); no persistent sessions; no file-based coordination
**Steal**: **Handoff-as-tool-call** is elegant. Meridian's `spawn_agent` already does this, but the clean handoff concept (where the conversation continues under a different agent's control) could be useful for Persona switching mid-conversation.

### Google ADK

**Approach**: Event-driven framework with parent-child agent hierarchy.

| Feature | Implementation |
|---------|---------------|
| **Agent hierarchy** | Parent agents coordinate sub-agents via `sub_agents` parameter |
| **State flow** | Shared `session.state` dict; agents write via `output_key`, read via template syntax `{key}` |
| **Workflow agents** | `SequentialAgent`, `ParallelAgent`, `LoopAgent` for predictable pipelines |
| **Dynamic routing** | `CoordinatorAgent` uses LLM to delegate to specialists |
| **Agent-as-tool** | `AgentTool(agent_name)` wraps agent as callable tool |
| **Loop patterns** | Generator-Critic validation loops with `max_iterations` |

**Pros vs Meridian**:
- `output_key` + template syntax for state flow is clean and explicit
- ParallelAgent with unique state keys prevents race conditions
- LoopAgent enables iterative refinement (generator → critic → refine)

**Cons vs Meridian**: Code-first only, no file-based agent definitions, Google ecosystem bias
**Steal**: **Generator-Critic loops** — for writing revision workflows, a loop where one agent generates and another critiques until quality threshold is met would be powerful

---

## 4. Non-AI Workflow Tools

### Linear

**Approach**: Hierarchical work items with cycle-based execution.

| Concept | Mapping to Agent Orchestration |
|---------|-------------------------------|
| **Issues** | Atomic tasks (like Meridian's subagent tasks) |
| **Projects** | Groups of related issues (like Meridian's sessions) |
| **Cycles** | Time-boxed work periods (no direct analog) |
| **Sub-issues** | Hierarchical decomposition (like Meridian's parent→child threads) |
| **Teams** | Ownership boundaries (like agent type restrictions) |
| **States** | Workflow stages (In Progress, Done, etc.) |

**Steal**: **State machine for work items** — Linear's issue states (Backlog → Todo → In Progress → Done) could map to subagent lifecycle states. Meridian currently has thread statuses but could benefit from a more explicit state machine.

### Notion

**Approach**: Flexible databases with views, relations, and automations.

- **Hierarchical pages** enable arbitrary nesting (like thread trees)
- **Database relations** enable cross-referencing between work items
- **Views** (Board, Timeline, Calendar) provide different perspectives on the same data

**Steal**: **Multiple views of the same data** — Meridian's thread tree could support board view (kanban of subagent statuses), timeline view (execution timeline), and tree view (parent-child hierarchy)

---

## 5. Novel Patterns from Other Domains

### Blackboard Architecture (Game AI / Robotics)

**Approach**: Shared key-value store that all agents read/write. No direct agent-to-agent communication.

- **Public sections** visible to all agents
- **Private sections** for specific agent groups
- **Control unit** (LLM) dynamically selects which agents act based on blackboard state
- **Cyclic execution**: examine → select agents → execute → update blackboard → repeat

**Relevance to Meridian**: This is essentially what `.session/` already does! Meridian's shared session filesystem IS a blackboard. The insight is that **the control unit (which agents to activate) should be driven by blackboard state, not just by user request**.

**Steal**: **Dynamic agent activation based on shared state** — when `.session/` artifacts change, automatically determine which agents should respond. E.g., when `consistency_issues.md` is updated, auto-spawn a resolution agent.

### Erlang Supervisor Trees (Distributed Systems)

**Approach**: Hierarchical actor supervision with "let it crash" philosophy.

- **Actors** = lightweight processes with own state, communicate via message passing
- **Supervisor trees** = parent actors restart children on failure
- **Strategies**: one_for_one (restart failed child), one_for_all (restart all children), rest_for_one (restart failed + all after it)

**Relevance to Meridian**:
- Meridian's parent→child thread relationship IS a supervisor tree
- Currently no restart/recovery strategy for failed subagents

**Steal**:
- **Restart strategies** — when a subagent fails, the parent should have configurable recovery: retry, spawn replacement, escalate to user
- **"Let it crash"** — subagents should be cheap to spawn/kill; design for failure recovery rather than failure prevention
- **Backpressure** — when too many subagents are running, queue rather than reject

### Behavior Trees (Game AI)

**Approach**: Hierarchical task decomposition with fallback and parallel nodes.

- **Sequence nodes**: execute children in order, fail if any fails
- **Selector/Fallback nodes**: try children in order, succeed on first success
- **Parallel nodes**: execute children simultaneously
- **Decorators**: modify child behavior (retry, timeout, invert)

**Relevance to Meridian**: Writing workflows could be modeled as behavior trees:

```
Sequence
├── Research (Parallel)
│   ├── Check character consistency
│   └── Check timeline consistency
├── Selector (fallback)
│   ├── Auto-fix simple issues
│   └── Flag complex issues for user
└── Generate chapter draft
```

**Steal**: **Fallback/retry patterns** — when an agent approach fails, automatically try an alternative approach before escalating

---

## 6. Pattern-by-Pattern Comparison

### Spawns as Threads vs Spawns as Separate Entities

| Approach | Who Uses It | Pros | Cons |
|----------|-------------|------|------|
| **Spawns as threads** (Meridian, Claude Code subagents) | Meridian, Claude Code | Natural conversation model; results flow as tool_result; shared session context | Coupled to parent; no peer-to-peer; nesting limitations |
| **Spawns as jobs/tasks** (Cursor, SAMAMS) | Cursor, SAMAMS | Strong isolation; independent lifecycle; cloud execution | No shared context; merge complexity; coordination overhead |
| **Spawns as conversation participants** (AutoGen) | AutoGen, AG2 | Natural for debate/critique; emergent coordination | Expensive (every turn = LLM call); hard to control |
| **Spawns as pipeline nodes** (LangGraph, SK) | LangGraph, Semantic Kernel | Deterministic; efficient; predictable | Inflexible; no emergent behavior |

**Meridian's position**: Thread model is the right choice for a writing platform. Writers think in conversations, and the thread model maps naturally to "ask an agent, get a response." The limitation is peer-to-peer coordination — Claude Code's Agent Teams show this is a real need.

### Agent Profiles: Files vs Database vs Code

| Approach | Who Uses It | Pros | Cons |
|----------|-------------|------|------|
| **Markdown files + YAML frontmatter** | Claude Code, Meridian (planned) | Version-controllable; human-readable; git-native; sharable | No dynamic generation; harder to query; schema validation weak |
| **YAML config files** | CrewAI | Structured; separated from code; templatable | Less flexible than markdown; no prose system prompts |
| **Database records** | Meridian (Personas/Agents in DB) | Dynamic creation; queryable; good for user-generated content | Not version-controllable; migration overhead; harder to share |
| **Code-defined** | AutoGen, LangGraph, OpenAI SDK, Google ADK | Maximum flexibility; type-safe; full programmatic control | Not user-editable; requires deployment for changes; not sharable |

**Meridian's position**: Hybrid approach (database for Personas, code for built-in Agents) is pragmatic. The file-based approach from Claude Code is superior for developer/power-user workflows, but database storage is correct for a web-based product where users create Personas via UI. Consider: **export Personas as markdown files** for sharing/version control, similar to how Claude Code agent profiles work.

### Background Execution: Polling vs Push vs Event-Driven

| Approach | Who Uses It | Pros | Cons |
|----------|-------------|------|------|
| **SSE push** (Meridian) | Meridian | Real-time updates; efficient; reconnectable | Connection management complexity |
| **Polling** (traditional) | Many web apps | Simple; stateless | Latency; wasteful |
| **Event-driven** (Google ADK) | Google ADK | Decoupled; scalable | Complexity; ordering challenges |
| **WebSocket** (Claude Code Teams) | Claude Code | Bidirectional; low latency | Connection management; scaling |
| **File-watching** (Claude Code subagents) | Claude Code (task files) | Simple; filesystem-native | Latency; polling underneath |

**Meridian's position**: SSE is the right choice for a web platform. Already battle-tested in Meridian's streaming infrastructure.

### Work Session Isolation: Shared FS vs Message Passing vs Both

| Approach | Who Uses It | Pros | Cons |
|----------|-------------|------|------|
| **Shared filesystem** (`.session/`) | Meridian | Persistent artifacts; natural for document-heavy workflows; agents can discover context | Race conditions; no structured schema; cleanup complexity |
| **Message passing only** | AutoGen, OpenAI SDK | Clean interfaces; no shared mutable state | Ephemeral; context lost between messages; verbose |
| **Shared typed state** | LangGraph, Google ADK | Structured; typed; checkpointable | Less flexible; requires schema design |
| **Shared task list + messaging** | Claude Code Teams | Structured coordination; peer-to-peer; file locking | Higher complexity; more coordination overhead |
| **Git worktrees** | Cursor, Claude Code, SAMAMS | Strong isolation; merge-based coordination | Physical copies; merge conflicts; no real-time sharing |

**Meridian's position**: Shared FS is excellent for a writing platform where agents produce document-like artifacts. Consider adding **structured metadata** (like a manifest or index file in `.session/`) alongside unstructured files.

### Visibility Flags

| Approach | Who Uses It | Pros | Cons |
|----------|-------------|------|------|
| **Persona (user) vs Agent (spawnable)** | Meridian | Clean separation; users see what matters | Two concepts to maintain |
| **Description-based auto-delegation** | Claude Code | Simple; LLM decides when to delegate | Less predictable |
| **Role-based access** | CrewAI (allow_delegation) | Explicit control | Requires permission management |
| **Hierarchical (parent can see children)** | Google ADK | Natural tree structure | Limited peer visibility |

**Meridian's position**: The Persona/Agent split is clean and maps well to a consumer product. Users shouldn't need to know about internal agents.

---

## 7. Ideas Worth Stealing (Prioritized)

### High Priority (Clear fit for Meridian)

1. **Persistent Agent Memory** (Claude Code) — Agents that accumulate knowledge across sessions. A "Character Expert" agent that remembers every character detail it has ever analyzed. Store in `.meridian/agent-memory/`.

2. **Generator-Critic Loops** (Google ADK) — Iterative refinement where one agent generates and another critiques. Perfect for writing revision workflows: draft → critique → revise → critique → done.

3. **Lifecycle Hooks** (Claude Code) — SubagentStart/SubagentStop events for setup/teardown. Could trigger UI notifications, cost tracking, or automatic quality gates.

4. **Structured Codex Auto-Linking** (NovelCrafter) — Auto-detect entity references in conversation and inject relevant structured data. Complements existing `doc_search` with more precise, curated context.

5. **Restart/Recovery Strategies** (Erlang) — When subagents fail, configurable recovery: retry with same context, spawn fresh, escalate to user, or abort session.

### Medium Priority (Worth exploring)

6. **Background Planning Agent** (Windsurf) — Dedicated agent that continuously refines the long-term plan while the working agent executes. Could help with long-form writing projects.

7. **GroupChat with Speaker Selection** (AutoGen/AG2) — Multiple personas debating in a shared conversation (editor vs. fact-checker vs. prose stylist). Useful for "get multiple perspectives" workflows.

8. **Multiple Views of Thread Data** (Notion/Linear) — Tree view, board view (kanban of subagent statuses), timeline view for the same thread/session data.

9. **Agent-Scoped MCP Servers** (Claude Code) — Give specific agents access to specific external tools (e.g., only the research agent gets web search).

10. **Unified Orchestration API** (Semantic Kernel) — Single interface to swap between sequential/parallel/group-chat modes for different writing tasks.

### Lower Priority (Interesting but not urgent)

11. **Dynamic Agent Activation from Shared State** (Blackboard) — When `.session/` artifacts change, auto-determine which agents should respond.

12. **Behavior Tree Fallbacks** (Game AI) — When one approach fails, automatically try alternatives before escalating.

13. **Export Agent Profiles as Shareable Markdown** — Enable sharing Personas as markdown files for version control and community sharing.

---

## 8. Key Takeaways

### What Meridian Gets Right

1. **Spawns-as-threads** is the correct model for a writing platform — conversations are the natural unit of interaction
2. **Shared `.session/` filesystem** is the right coordination mechanism for document-heavy workflows
3. **Persona/Agent separation** correctly maps the user-facing vs. internal distinction
4. **CAS concurrency** for document writes is more sophisticated than any competitor
5. **Built-in agents only (v1)** is the right scoping decision — avoid premature extensibility

### What Could Be Improved

1. **No persistent agent memory** — agents start fresh each conversation. Adding memory directories (like Claude Code) would enable agents that get better over time
2. **No failure recovery strategy** — when subagents fail, there's no automatic recovery (retry, restart, fallback)
3. **No peer-to-peer agent communication** — current model is strictly parent→child. Agent Teams pattern from Claude Code shows this limitation
4. **Unstructured session artifacts** — `.session/` files are unstructured; adding a structured index/manifest could improve discoverability
5. **No lifecycle hooks** — missing SubagentStart/SubagentStop events for automation and quality gates

### The Competitive Landscape Summary

| Product/Framework | Orchestration Maturity | Writing Domain Fit |
|-------------------|----------------------|-------------------|
| **Writing tools** (Sudowrite, NovelCrafter) | None (single agent) | High (writer UX) |
| **Claude Code** | High (subagents + teams + worktrees) | Low (developer-focused) |
| **Cursor** | High (cloud VMs, 8 parallel agents) | Low (IDE-native) |
| **CrewAI** | Medium (YAML + roles + tasks) | Low (generic framework) |
| **AutoGen/AG2** | High (GroupChat + Swarm unified) | Low (conversation-heavy) |
| **LangGraph** | High (graph + state + checkpointing) | Low (graph-centric) |
| **Google ADK** | High (event-driven + patterns) | Low (Google ecosystem) |
| **Meridian** (planned) | Medium (spawns + shared FS + CAS) | **Highest** (writer-first) |

**Meridian's unique position**: No product combines sophisticated agent orchestration with writer-first UX. The agent framework would be the first of its kind in the creative writing space.

---

## Sources

### Writing Platforms
- [Sudowrite vs Novelcrafter](https://sudowrite.com/blog/sudowrite-vs-novelcrafter-the-ultimate-ai-showdown-for-novelists/)
- [NovelCrafter Codex](https://docs.novelcrafter.com/en/articles/8675743-the-codex)
- [NovelCrafter Features](https://www.novelcrafter.com/features)

### AI Coding Tools
- [Claude Code Subagents](https://code.claude.com/docs/en/sub-agents)
- [Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams)
- [Cursor 2.0 Multi-Agent Architecture](https://www.artezio.com/pressroom/blog/revolutionizes-architecture-proprietary/)
- [SAMAMS Multi-Agent Orchestration for Cursor](https://dev.to/_e0368f0daab8aa68fd6e1d/i-built-an-orchestration-layer-to-manage-multiple-cursor-agents-3iab)
- [Windsurf Cascade](https://windsurf.com/cascade)
- [Cline vs Claude](https://emergent.sh/learn/claude-vs-cline)

### Agent Frameworks
- [CrewAI Agents](https://docs.crewai.com/en/concepts/agents)
- [AutoGen Multi-Agent Conversation](https://microsoft.github.io/autogen/0.2/docs/Use-Cases/agent_chat/)
- [AG2 v0.9 GroupChat](https://docs.ag2.ai/latest/docs/blog/2025/04/28/0.9-Release-Announcement/)
- [LangGraph vs CrewAI vs AutoGen Guide](https://dev.to/pockit_tools/langgraph-vs-crewai-vs-autogen-the-complete-multi-agent-ai-orchestration-guide-for-2026-2d63)
- [Semantic Kernel Agent Orchestration](https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-orchestration/)
- [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/)
- [Google ADK Multi-Agent Patterns](https://developers.googleblog.com/developers-guide-to-multi-agent-patterns-in-adk/)

### Novel Patterns
- [Blackboard Architecture for LLM Agents](https://arxiv.org/html/2507.01701v1)
- [Erlang Actor Model & Supervisor Trees](https://www.freshcodeit.com/blog/why-elixir-is-the-best-runtime-for-building-agentic-workflows)
- [Behavior Trees in Robotics and AI](https://arxiv.org/abs/1709.00084)
- [AI Blackboard Architecture for Game AI](https://tonogameconsultants.com/ai-blackboard/)
