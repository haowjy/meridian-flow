# Migration Plan

Phased rollout from current state. Each phase is independently deployable and testable.

## Phase 1: Personas

**Prerequisite**: A3 agent catalog does not exist in code yet -- only skills.

1. **Migration**: `persona` column on threads AND turns (per-turn tracking for replay fidelity). `internal` role constraint on turns.
2. **`internal` turn support**: Extend `CreateTurnRequest`, `MessageBuilder`, turn validation. Translate `internal` -> `user` with `[System notification]:` prefix for all providers.
3. **`domain/agents/` package**: `Persona` struct, `PersonaCatalog` interface (split resolver from lister per ISP).
4. **`service/agents/` package**: Catalog reads `.agents/agents/*.md` from document tree. Parses YAML frontmatter (new shared frontmatter parser — none exists). Preserves nil vs empty for `tools`.
5. **Thread creation**: Accept `persona` on any turn. Validate slug + resolve against catalog. Store persona slug on both thread and turn.
6. **System prompt resolver**: Append persona body as last section (position 7) for cache optimization.
7. **Model override**: Override model/temperature/max_tokens from persona.
8. **Tool filtering**: `nil` = all tools, `[]` = no tools, explicit list = only those.
9. **Skill override + visibility**: `user_selectable` and `agent_usable` flags.
10. **ThreadNotifier**: Generic "push message to thread" primitive. Handles idle (create internal turn, auto-wake) vs mid-stream (queue for next tool round). Sends WebSocket `thread_activity` event to connected clients.

**Verification**: Users create threads as specific agents. Different model, persona, tools. ThreadNotifier delivers test notifications. No spawning yet.

## Phase 2: Work Sessions + Foreground Spawning

1. **Migration**: `parent_thread_id`, `spawn_status`, `spawn_result` on threads. `background_tasks` table. `agent_install_state` table.
2. **Streaming service gate**: Check work item status before `CreateTurn`. 409 on done/deleted.
3. **Lazy work item provisioning**: Create ephemeral if missing (A4 design).
4. **Cold-start reorder**: Split into "create/persist thread + work item" then "resolve prompt/tools from persisted context" (not a simple line reorder — several pre-stream steps currently assume thread doesn't exist yet).
5. **Context resolver**: Build `ResolvedContext` from thread's work item.
6. **System prompt**: Add work context section at position 3.
7. **Namespace access**: Allow `.meridian/work/<slug>/` and `.meridian/fs/` writes. Requires builder signature change, tool struct change, and namespace policy rewrite (not just "inject slug").
8. **Autoapply defaults**: `.meridian/work/` and `.meridian/fs/` = on. `.agents/` = off.
9. **Foreground spawning**: Spawn orchestration inside streaming service (no separate SpawnService package for v1 — extract when a second caller exists). spawn_agent tool blocks on channel, child completion sends result. Note: blocks entire tool round due to ExecuteParallel batch barrier.
10. **Spawn limits**: Depth + concurrent checks with `SELECT ... FOR UPDATE`.
11. **Cancellation cascade**: Parent interruption cascades to running children. Ships with spawn support.
12. **Work item completion gate**: Row-level lock in same tx as status transition.
13. **Spawn status endpoints**: `GET /threads/{id}/spawns`, extended `GET /threads/{id}`.
14. **Thread tree endpoint**: `GET /projects/{id}/work-items/{slug}/thread-tree`.

15. **Context management — autocollapse + autocompact**: System-driven, no LLM tools. See [context-management](context-management.md).
    - Migration: `collapsed_content TEXT` column on turn_blocks.
    - Pre-compute `collapsed_content` at tool execution time in tool executor.
    - Collapse bookmark turn type: MessageBuilder uses `collapsed_content` for tool_result blocks before the marker.
    - Compact bookmark turn type: MessageBuilder skips turns before it, uses summary.
    - CompactionService: fast model summarization, creates compaction bookmark turn.
    - TokenMonitor: counts tokens per thread, triggers autocollapse at threshold (e.g., 60%), then autocompact at higher threshold (e.g., 80%).
    - `query_history` tool: agent searches/reads pre-bookmark turns.
    - Escalation: autocollapse first (cheap, instant) → autocompact (LLM call) → notify user.

**Verification**: Agents are work-session-aware. Foreground spawns block and return results. Cancellation cascades. Thread tree renders. Autocollapse and autocompact fire at token thresholds. History queryable after compaction.

## Phase 3: Background Execution + Hardening

1. **ToolMetadata**: Add `SupportsBackground` field.
2. **Background-aware execution**: Executor creates `background_tasks` row, returns handle, launches work with **detached context** (goroutine must outlive parent stream). For spawns, child is its own streaming session. For bash, goroutine with root context.
3. **`check_background` tool**: Queries `background_tasks` by thread_id. Metadata guideline teaches LLM when to poll.
4. **Completion notification**: Via ThreadNotifier (built in Phase 1). Background task completion -> `ThreadNotifier.Notify()` + WebSocket `thread_activity`.
5. **Server restart recovery**: Scan orphaned running tasks. Re-attach spawn watchers, fail bash tasks.
6. **Spawn result extraction**: Fallback order: report > last text (4KB) > status message.
7. **Compare-and-swap on spawn status**: Terminal states can't be overwritten.
8. **Agent install state**: Optimistic concurrency (version CAS).

**Verification**: Background spawns and bash return handles immediately. Completion auto-wakes idle parents. Restart recovery works.

## Post-v1

- CLI advanced features: continue/fork, stats, reports, --from context passing, permission tiers
- Thread-tree API enrichment: thread_kind, needs_input, preview, affected files
- Marketplace UI
- Deleted persona UX polish
- Cache optimization: move persona body from system prompt to current user message injection (requires MessageBuilder interface changes)

## Implementation Surface

### New Packages

| Package | Phase | Purpose |
|---------|-------|---------|
| `domain/agents/` | 1 | Persona, PersonaCatalog interface |
| `service/agents/` | 1 | Catalog from document tree |
| `domain/spawn/` | 3 | SpawnRequest, SpawnResult, narrow interfaces |
| `service/spawn/` | 3 | Spawn service |
| `tools/spawn_agent.go` | 3 | spawn_agent tool |
| `tools/check_background.go` | 2.5 | check_background tool |
| `streaming/context_resolver.go` | 2 | Work context resolution |
| `streaming/compaction_service.go` | 2 | Compaction + collapse bookmark creation, token monitoring |
| `tools/query_history.go` | 2 | query_history tool for pre-bookmark turns |
| `streaming/background_task_service.go` | 3 | Durable task tracker |

### Modified Packages

| File | Phase | Changes |
|------|-------|---------|
| `domain/llm/thread.go` | 1+2 | New fields |
| `domain/llm/system_prompt.go` | 1+2 | Extended Resolve() signature |
| `streaming/turn_creation.go` | 1+2 | Persona resolution, work item gate, cold-start reorder |
| `streaming/system_prompt_resolver.go` | 1+2 | Work context section; persona body last |
| `domain/llm/turn_block.go` | 2 | Add `collapsed_content` field |
| `service/llm/thread_history/message_builder.go` | 2 | Respect collapse + compact bookmarks |
| `streaming/stream_executor.go` | 2.5 | Background-aware tool execution |
| `tools/builder.go` | 2+3 | WithSpawnTool(), WithCheckBackgroundTool() |
| `tools/metadata.go` | 2.5 | SupportsBackground |
| `tools/text_editor.go` | 2 | Work-item-scoped writes |
| `setup.go` | 1+3 | Wire catalog, spawn, context resolver |
| `handler/thread.go` | 1+3 | Extended responses, spawn endpoints |
| `handler/work_item.go` | 3 | Thread tree endpoint |
| `repository/postgres/llm/thread.go` | 1+2 | New columns + spawn queries |
| `app/domains/llm.go` | 1+3 | Wire into LLMCrossDeps |

### Migrations

| Migration | Phase | Contents |
|-----------|-------|----------|
| `xxx_add_persona.sql` | 1 | `persona` column, `internal` role constraint |
| `xxx_add_spawn_columns.sql` | 2 | Spawn columns, `agent_install_state`, `collapsed_content` on turn_blocks, indexes |

## Coder Notes

- Reuse `TransactionManager.ExecTx` for spawn creation (thread + turns in one tx)
- `spawn_agent` must return `tool_result` block, not start a new streaming round
- `waiting_subagents` already exists in `TurnStatus` enum
- Context variables are literal strings in system prompt, not expandable variables
- All spawn queries filter by `deleted_at IS NULL`
- Spawn result extraction: report > last text (4KB) > status message

## Review Findings (All Addressed)

### Round 1-2

| Finding | Resolution |
|---------|-----------|
| Background tasks not durable | `background_tasks` table |
| No parent-turn <-> spawn edge | `background_tasks.parent_turn_id` + `tool_use_id` |
| Immutable persona vs hot-reload | Slug switchable per-turn, content resolves per-turn |
| `agent_spawnable` overloaded | Split: `spawnable` + `agent_usable` |
| Tool whitelist default ambiguous | nil = all, empty = none, list = only those |
| Idle parent never wakes up | Internal turn auto-wake |
| No executor suspension needed | Background tools return handle immediately |
| Path traversal risk | `filepath.Clean` canonicalization |
| `.meridian/fs/` write policy | Autoapply on. History for restore. |
| Persona rename bricks threads | Recoverable -- switch to valid persona or clear |
| Write routing contradiction | All writes through collab pipeline |

### Round 3

| Finding | Severity | Resolution |
|---------|----------|-----------|
| DDL targets `chats` not `threads` | CRITICAL | Fixed to `${TABLE_PREFIX}threads` |
| Cascade cancel deferred | CRITICAL | Moved into Phase 3 |
| Work-item write isolation | HIGH | `workItemSlug` enforcement in tool layer |
| Background tool contract mismatch | HIGH | Phase 2.5 prerequisite |
| Cold-start prompt ordering | HIGH | Thread created before prompt resolution |
| Circular dependency | HIGH | Narrow interfaces: `ChildThreadBootstrapper` + `SpawnInvoker` |
| CLI parity overstated | HIGH | Narrowed to "v1 subset parity" |
| Check-then-act spawn limits | HIGH | `SELECT ... FOR UPDATE` in same tx |
| `internal` turn incompatible | HIGH | First-class migration in Phase 1 |
| Interjection != spawn resumption | HIGH | Three distinct completion paths |
| Work-item completion TOCTOU | HIGH | Row-level lock |
| `parent_thread_id ON DELETE SET NULL` | MEDIUM | Changed to RESTRICT |
| `background_tasks` FK cascades | MEDIUM | Added ON DELETE CASCADE |
| Naming lacks TABLE_PREFIX | MEDIUM | Fixed |
| Missing running-spawns index | MEDIUM | Added partial index |
| `persona` unconstrained | MEDIUM | Slug format CHECK |
| `spawn_result` no validation | MEDIUM | Typed schema at service layer |
| `agent_install_state` last-writer-wins | MEDIUM | Version CAS |
