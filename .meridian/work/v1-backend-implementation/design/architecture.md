# v1 Backend Architecture

Complete map of what exists, what needs to be built, and how it all connects.

## Current Backend State

### What Exists (52 endpoints, 7 tools, 5 domains)

```
Domains:         billing ✅, collab ✅, docsystem ✅, llm ✅, skill ✅
Streaming:       CreateTurn, SSE, tool loop, cancellation, billing settlement
Tools:           text_editor, doc_search, web_search, thread_context, skill_invoke, path_resolver
Token counting:  Output-only (interrupted streams), Anthropic count API
Capabilities:    YAML registry with ContextWindow, MaxOutput, pricing tiers, tool support
Providers:       Anthropic + OpenRouter (via meridian-llm-go)
Auth:            Supabase JWT, route protection
Billing:         Credit ledger, FIFO consumption, Stripe checkout, webhooks
```

### What Doesn't Exist Yet

```
Work items:      No work_items table, no artifact folders, no thread grouping
Personas:        No .agents/agents/ catalog, no per-turn persona switching
File-first:      Skills still in project_skills table, no .agents/ namespace
Spawning:        No child threads, no spawn tool, no cancellation cascade
Context mgmt:    No collapse/compact bookmarks, no token monitoring
Token estimation: No input counting, no dry-run, no context budget API
Provider middleware: Designed but not implemented in meridian-llm-go
```

## Feature Dependency Layers

### Layer 0: Base Refactors

Three independent refactors to existing code. All can run in parallel.

| Refactor | What changes | Why it's prerequisite |
|----------|-------------|----------------------|
| **R1: Cold-start reorder** | `turn_creation.go` — create thread in tx BEFORE prompt resolution | Work items need thread to exist before attaching. Persona needs thread context for resolution. |
| **R2: System prompt extension** | `system_prompt_resolver.go` — accept `PromptContext` struct | Persona body injection (position 7), work context injection (position 3). Without this, every feature modifies the same function. |
| **R3: Token counting library** | New `TokenEstimator` interface + Anthropic/tiktoken impls | Context management triggers need to know current usage. Pre-action cost estimates need dry-run. |

See [base-refactors.md](base-refactors.md) for details.

### Layer 1: Foundations (parallel after Layer 0)

| Feature | Design doc | Key deliverables | Depends on |
|---------|-----------|-----------------|------------|
| **A3: File-first storage** | [file-first-storage.md](file-first-storage.md) | `.agents/` namespace, frontmatter parser, persona catalog interface, skill resolver interface | — |
| **A4: Work items** | [work-items.md](work-items.md) | `work_items` table, CRUD, ephemeral auto-create, artifact folders, thread FK, cursor pagination | R1 |
| **Token budget** | [token-budget.md](token-budget.md) | Token estimator registry, Anthropic/tiktoken impls, context budget API | R3 |

### Layer 2: Core Services (parallel after Layer 1)

| Feature | Design doc | Key deliverables | Depends on |
|---------|-----------|-----------------|------------|
| **Skill migration** | [skill-migration.md](skill-migration.md) | Dual-read resolver, shadow file refresh, backfill, invocation policy | A3 |
| **Agent import** | [agent-import.md](agent-import.md) | Git import, SSRF/DNS protection, atomic stage-commit, collision policy | A3 |
| **A5: Agent tools** | [agent-tools.md](agent-tools.md) | Namespace rewrite, write routing, context variable injection | A4 |
| **Provider middleware** | [provider-middleware.md](provider-middleware.md) | Generic middleware layer + usage metering in meridian-llm-go | — (library work) |

### Layer 3: Agent Runtime (after Layer 2)

| Feature | Design doc | Key deliverables | Depends on |
|---------|-----------|-----------------|------------|
| **Personas** | [personas.md](personas.md) | Catalog service, turn creation integration, model/tool/skill override, API | A3, A5, R2 |
| **Context management** | [context-management.md](context-management.md) | Autocollapse, autocompact, bookmark turns, MessageBuilder changes, token monitor | Token budget |

### Layer 4: Orchestration (after Layer 3)

| Feature | Design doc | Key deliverables | Depends on |
|---------|-----------|-----------------|------------|
| **Foreground spawning** | [subagent-spawning.md](subagent-spawning.md) | spawn_agent tool, child threads, blocking wait, cancellation cascade, spawn limits | Personas, A4 |
| **Background execution** | [background-execution.md](background-execution.md) | background_tasks table, detached goroutine, server restart recovery | Spawning |
| **Thread notifications** | [thread-notifications.md](thread-notifications.md) | ThreadNotifier, internal turns, WebSocket thread_activity | Background execution |

## Execution Strategy

### Phase 1: Base + Foundations (Rounds 1-3)

```
Round 1 (parallel):
  R1: Cold-start reorder           [opus coder, high risk]
  R2: System prompt extension       [sonnet coder, medium risk]
  R3: Token counting library        [sonnet coder, medium risk]
  A3: .agents/ namespace bootstrap  [sonnet coder, low risk]

Round 2 (parallel, after R1):
  A4: Work items (full)             [sonnet coder, high risk — 867L design]
  A3: Frontmatter parser + resolver [sonnet coder, medium risk]
  Token budget: Estimator registry  [sonnet coder, medium risk]

Round 3 (parallel):
  Skill migration: dual-read        [sonnet coder, medium risk]
  Agent import: git import           [opus coder, high risk — SSRF]
  A5: Namespace rewrite             [sonnet coder, high risk — security]
  A5: Context variables             [routine coder, low risk]
```

### Phase 2: Agent Runtime (Rounds 4-6)

```
Round 4 (parallel):
  Personas: catalog + domain types   [sonnet coder]
  Context mgmt: collapsed_content    [sonnet coder]
  Provider middleware: core           [sonnet coder]

Round 5 (sequential):
  Personas: turn creation integration [sonnet coder, high risk]
  Personas: system prompt + model     [sonnet coder]
  Personas: tool filtering + skills   [routine coder]
  Personas: API                       [routine coder]

Round 6 (parallel):
  Context mgmt: bookmarks + monitor  [sonnet coder]
  Provider middleware: usage metering [sonnet coder]
```

### Phase 3: Orchestration (Rounds 7-9)

```
Round 7:
  Foreground spawning               [opus coder, critical risk]

Round 8 (parallel):
  Cancellation cascade              [sonnet coder]
  Spawn limits                      [routine coder]
  Spawn endpoints                   [routine coder]

Round 9:
  Background execution              [opus coder, high risk]
  Thread notifications              [sonnet coder]
```

## Total Estimated Steps

| Layer | Steps | Risk profile |
|-------|:-----:|-------------|
| Layer 0: Base refactors | 3 | 1 critical, 2 medium |
| Layer 1: Foundations | ~15 | A4 is high risk (867L design) |
| Layer 2: Core services | ~15 | Agent import + namespace rewrite are high risk |
| Layer 3: Agent runtime | ~15 | Turn creation integration is high risk |
| Layer 4: Orchestration | ~10 | Foreground spawn is critical risk |
| **Total** | **~58** | |

## New Packages to Create

| Package | Purpose |
|---------|---------|
| `domain/workitem/` | Work item domain types + service/store interfaces |
| `domain/agents/` | Persona + RuntimeSkill types, catalog interfaces |
| `service/workitem/` | Work item service implementation |
| `service/agents/` | Persona catalog, skill resolver, git import |
| `repository/postgres/workitem/` | Work item store |
| `handler/work_item.go` | Work item REST endpoints |
| `pkg/frontmatter/` | Shared YAML frontmatter parser |
| `service/llm/tokens/estimator.go` | Token estimation (extend existing package) |
| `service/llm/streaming/context_resolver.go` | Work context resolution |
| `service/llm/streaming/spawn.go` | Spawn orchestration |
| `service/llm/streaming/token_monitor.go` | Context budget monitoring |
| `service/llm/tools/spawn_agent.go` | Spawn tool |

## Existing Files with Major Changes

| File | Current lines | What changes |
|------|:---:|-------------|
| `streaming/turn_creation.go` | 929 | Cold-start reorder, persona resolution, work item gate, spawn wiring |
| `streaming/system_prompt_resolver.go` | 224 | PromptContext struct, 7-position composition, persona body injection |
| `streaming/service.go` | ~400 | New deps (persona catalog, work item service, token monitor) |
| `streaming/stream_executor.go` | ~500 | Token monitor after completion, collapse bookmark placement |
| `tools/text_editor.go` | ~400 | Namespace access rewrite for work item isolation |
| `tools/builder.go` | ~200 | Spawn tool, work item slug, persona tool filter |
| `domain/llm/thread.go` | ~100 | WorkItemID, ParentThreadID, SpawnStatus, Persona fields |
| `domain/llm/turn.go` | ~80 | Persona field, collapsed_content on blocks |
| `handler/thread.go` | ~300 | Persona in response, spawn status, work item filter |

## What Makes It "Complete"

When all 4 layers ship, the backend supports:

- ✅ Writers create work items, threads are grouped, artifacts are scoped
- ✅ Personas define agent behavior + model, switchable per-turn
- ✅ Skills resolve from files (portable, git-importable)
- ✅ Agents can spawn sub-agents (foreground + background)
- ✅ Context is managed automatically (collapse → compact → warn)
- ✅ Token usage is tracked and estimated before sending
- ✅ Provider middleware enables usage metering and future hooks
- ✅ All existing functionality (billing, auth, collab, documents) continues working

What's NOT backend but needed for a complete app:
- Frontend v2 (all rounds 1-5 from implementation-plan.md)
- CM6 editor rebuild
- Layout shells and mode switching
- Landing page and onboarding
