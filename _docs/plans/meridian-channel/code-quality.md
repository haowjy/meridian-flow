# Code Quality — SRP, Layering, and Architecture

**Status:** draft

Addresses Gaps 12-15, 17 from post-sandbox review + architecture deep-dive findings.

---

## SRP Violations

### CQ-1: SQLite adapter is oversized (Gap 12 — updated)

**Severity:** MAJOR

**Problem:** Original `StateDB` was split, but the monolith moved to `lib/adapters/sqlite.py` (1,005 LOC). Mixes run/workspace/context/workflow/spans/artifacts concerns.

**Fix:** Split into domain-specific stores:
- `RunStore` — run CRUD, status transitions, queries
- `WorkspaceStore` — workspace state, session tracking
- `ContextStore` — pinned files, context management
- Keep `MigrationManager` separate

**Files:** `lib/adapters/sqlite.py:313,468,621,698`

### CQ-2: execute_with_finalization is oversized (Gap 13)

**Severity:** MAJOR

**Problem:** 286 lines mixing retry logic, budget enforcement, output extraction, and finalization.

**Fix:** Extract retry decorator/wrapper and budget guard. Keep finalization as orchestration point.

**Files:** `lib/exec/spawn.py:442-727`

### CQ-3: ops/config.py mixes concerns (Gap 14)

**Severity:** MAJOR

**Problem:** Config CRUD, init scaffolding, validation, async wrappers, and operation registration in one module.

**Fix:** Split `config_ops.py` (CRUD) + `config_init.py` (scaffolding).

**Files:** `lib/ops/config.py:580,689`

---

## Layering Violations

### CQ-4: lib/ops imports CLI format helpers (HIGH)

**Severity:** HIGH
**Source:** Architecture review

**Problem:** `ops/models`, `ops/diag`, `ops/skills`, `ops/_run_models` import `meridian.cli.format_helpers` inside `format_text()`. Domain layer depending on interface layer — inverts layering.

**Fix:** Move `format_text()` implementations to CLI layer. Ops layer returns data; CLI formats it.

**Files:** `lib/ops/models.py:35`, `lib/ops/diag.py:48`, `lib/ops/skills.py:47`, `lib/ops/_run_models.py:128`

### CQ-5: CLI imports server at module level (MEDIUM)

**Severity:** MEDIUM
**Source:** Architecture review

**Problem:** `cli/main.py` imports `run_server` from `server/main.py` at module level, coupling CLI startup to MCP server stack.

**Fix:** Lazy import `run_server` inside the serve command handler.

**Files:** `cli/main.py:29,152`, `server/main.py:8`

### CQ-6: Config depends on state/ops layers (MEDIUM)

**Severity:** MEDIUM
**Source:** Architecture review

**Problem:** Config loader imports `resolve_state_paths` from state layer, and `config/agent.py` imports from ops registry. Wrong dependency direction.

**Fix:** Extract path resolution to a shared utility. Agent config should receive tool names via parameter, not import registry.

**Files:** `lib/config/settings.py:12,371`, `lib/config/agent.py:67`

### CQ-7: Registry sync_handler bypassed by CLI (MEDIUM)

**Severity:** MEDIUM
**Source:** Architecture review

**Problem:** Registry defines `sync_handler` but CLI ignores it and hard-codes per-op handler maps with direct `_sync` calls. Duplicate wiring.

**Fix:** CLI should dispatch through `op.sync_handler` from registry instead of maintaining separate handler maps.

**Files:** `lib/ops/registry.py:28`, `cli/run.py:212,69`, `cli/config_cmd.py:50`

### CQ-8: Raw sqlite3.connect bypasses store abstractions (MEDIUM)

**Severity:** MEDIUM
**Source:** Architecture review

**Problem:** Several ops/workspace paths use raw `sqlite3.connect()` instead of going through StateDB/store abstractions.

**Fix:** Route all DB access through store layer.

**Files:** `lib/ops/run.py:230`, `lib/ops/_run_query.py:20`, `lib/workspace/summary.py:27`, `lib/workspace/crud.py:41`

---

## Import Health

### CQ-9: Import-time side effects (Gap 15)

**Severity:** MAJOR

**Problem:** CLI and server modules force heavy registration/bootstrap at import. Partially mitigated by lazy bootstrap in registry (Task 7d). Remaining eager imports in CLI and server entry points.

**Fix:** Audit `cli/main.py` and `server/` for remaining eager imports. Lazy-import heavy deps.

**Files:** `cli/main.py:16,336`, `server/main.py:77`

### CQ-10: Cycle-prone import path (LOW)

**Severity:** LOW
**Source:** Architecture review

**Problem:** `lib/ops` → `cli.format_helpers` → `cli/__init__` → `cli.main` → `server.main`. Currently deferred (function-scope), but structurally fragile.

**Fix:** Resolves automatically when CQ-4 is fixed (moving format_text to CLI layer).

---

## Scaling Concerns

### CQ-11: Run lifecycle writes serialized via flock (HIGH at scale)

**Severity:** HIGH (at 100+ concurrent runs)
**Source:** Architecture review

**Problem:** `append_start_row` and `append_finalize_row` hold exclusive `flock` + SQLite transaction. 100 runs = ~200 serialized lock sections.

**Fix:** For current local-first scope, acceptable. If scaling: move to WAL-only (no flock), or async DB writes, or batch lifecycle updates.

**Files:** `lib/adapters/sqlite.py:155,214`, `lib/state/jsonl.py:17`

### CQ-12: Connection churn (MEDIUM at scale)

**Severity:** MEDIUM (at scale)
**Source:** Architecture review

**Problem:** Every StateDB operation opens/closes a connection, running PRAGMAs + migration check each time.

**Fix:** Connection pooling or long-lived connections within a process.

**Files:** `lib/adapters/sqlite.py:127,314,372`

### CQ-13: Async path blocked by sync DB I/O (MEDIUM)

**Severity:** MEDIUM
**Source:** Architecture review

**Problem:** `execute_with_finalization()` is async but does blocking SQLite I/O before first await.

**Fix:** Move DB writes to `asyncio.to_thread()` or use aiosqlite.

**Files:** `lib/exec/spawn.py:442,512`

---

## Minor

### CQ-14: Silent parse-error swallow (Gap 17)

**Severity:** MINOR

**Problem:** Workspace lock cleanup silently swallows parse errors.

**Fix:** Add `logger.debug()`.

**Files:** `lib/workspace/launch.py`

### CQ-15: HarnessAdapter abstraction leaks for DirectAdapter (MEDIUM)

**Severity:** MEDIUM
**Source:** Architecture review

**Problem:** Protocol is CLI/subprocess-shaped (`build_command`, stream parsing). `DirectAdapter`'s real path is async `execute()` which is not in the protocol. `supports_programmatic_tools` exists but isn't used for dispatch.

**Fix:** Add `execute()` to protocol or split into `CLIHarnessAdapter` and `ProgrammaticHarnessAdapter`.

**Files:** `lib/harness/adapter.py:28,89`, `lib/harness/direct.py:83,197`, `lib/exec/spawn.py:540,568`

### CQ-16: Run lineage fields unused

**Severity:** MINOR
**Source:** Gap re-review

**Problem:** Schema defines `continues_run`/`retries_run` columns but runtime never writes/reads them. Continue/retry creates fresh runs without linkage.

**Fix:** Wire lineage fields into `run.continue`/`run.retry` flows, or remove from schema.

**Files:** `lib/state/schema.py:79-80`, `lib/adapters/sqlite.py:325-338`

