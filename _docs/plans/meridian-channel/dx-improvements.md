# Developer Experience Improvements

**Status:** draft

Findings from DX review. Scores represent current state (1-5 scale).

---

## Scores

| Area | Score | Summary |
|------|-------|---------|
| CLI UX | 2/5 | Misleading errors, no flag descriptions |
| MCP integration | 2/5 | Docs don't match actual schemas |
| Configuration | 3/5 | Init works, format is fine |
| Error handling | 2/5 | TimeoutError uncaught, inconsistent |
| Output formats | 3/5 | Porcelain collapses nested objects |
| Skill authoring | 2/5 | Hidden parser constraints, no tooling |
| Documentation | 2/5 | Docs claim features that don't exist |

---

## DX-1: MCP docs don't match tool schemas (HIGH)

**Problem:** Docs use wrong field names/types (`permission` vs `permission_tier`, object `template_vars` vs tuple, `space_id` vs `space`). `coerce_input_payload` silently drops unknown keys.

**Fix:**
- Auto-generate MCP docs from dataclass/registry definitions
- Fail loudly on unknown input keys instead of silent drop

**Files:** `docs/mcp-tools.md`, `lib/ops/codec.py:113`

---

## DX-2: Unknown command shows misleading error (HIGH)

**Problem:** `meridian init` or `meridian foo` shows "Invalid value for JSON" instead of "unknown command".

**Fix:** Add explicit unknown-command handling. Add `init` as top-level alias for `config init`.

**Files:** `cli/main.py:131`

---

## DX-3: CLI help lacks flag descriptions (MEDIUM)

**Problem:** Flags missing `help=` metadata. Noisy auto-generated `--empty-*` flags for tuple params visible in help output.

**Fix:** Add `help=` for every parameter. Hide internal `--empty-*` flags.

**Files:** `cli/run.py:44` and all command modules

---

## DX-4: Docs claim features that don't exist (MEDIUM)

**Problem:** Docs say `rich/plain/json/porcelain` output modes with TTY auto-detection. Code only supports `text/json/porcelain`.

**Fix:** Align docs to actual behavior. Or implement rich/plain if desired.

**Files:** `docs/cli-reference.md:11`, `cli/output.py:12`

---

## DX-5: TimeoutError not caught at CLI top level (MEDIUM)

**Problem:** `run_wait` raises `TimeoutError` but CLI handler doesn't catch it — produces ugly traceback.

**Fix:** Catch `TimeoutError`, return clean message + stable exit code.

**Files:** `lib/ops/run.py:308`, `cli/main.py:329`

---

## DX-6: Porcelain output not fully script-friendly (MEDIUM)

**Problem:** Nested structures collapse into JSON blobs in `key=value` porcelain fields.

**Fix:** Consider NDJSON mode or per-record porcelain lines with fixed fields.

**Files:** `cli/output.py:50`

---

## DX-7: Skill authoring has hidden constraints (MEDIUM)

**Problem:** Docs say "YAML frontmatter" but parser is constrained subset. Silently skips unsupported patterns.

**Fix:** Document exact supported grammar. Add `skills validate` and `skills init` scaffold commands.

**Files:** `docs/configuration.md:41`, `lib/config/skill.py:90`

---

## DX-8: Default prompt composition is very large (MEDIUM)

**Problem:** Even trivial prompts generate ~6.1k chars / ~854 words due to default skill injection. Permission escalation warnings fire against read-only config default.

**Fix:** Review default skill injection behavior. Consider opt-in vs opt-out for skill loading.

**Files:** `lib/prompt/compose.py`, `lib/ops/_run_prepare.py`

---

## DX-9: Supervisor harness settings not configurable (HIGH)

**Problem:** Supervisors need different harness behavior than subagents — lower compaction (stay sharp over long sessions), optional permission escalation (yolo). Currently `autocompact` is a raw passthrough arg with no structured config and no per-harness translation. Users have to know each harness's flags.

**Per-harness compaction control:**

| Harness | Mechanism | Supervisor default |
|---------|-----------|-------------------|
| Claude | `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` env var (1-100%) | 65 |
| Codex | No control available (hardcoded ~220k tokens) | skip |
| OpenCode | `compaction.threshold` in config (0.0-1.0) | 0.65 |

**Per-harness YOLO flags (supervisor-only, opt-in via `--unsafe`):**

| Harness | Flag |
|---------|------|
| Claude | `--dangerously-skip-permissions` |
| Codex | `--dangerously-bypass-approvals-and-sandbox` |
| OpenCode | `--dangerously-skip-permissions` |

**Fix:**
- Add `[supervisor]` section to config:
  ```toml
  [supervisor]
  permission_tier = "full-access"    # sane default, not yolo
  autocompact_pct = 65               # compact earlier to stay sharp
  ```
- Meridian translates `autocompact_pct` per-harness automatically (env var for Claude, config for OpenCode, skip for Codex)
- Never pass compaction overrides or yolo flags to subagents — enforced in command builder
- `--unsafe` on `meridian space start` unlocks danger tier

**Files:** `lib/space/launch.py:216-231`, `lib/safety/permissions.py:222-237`, `lib/config/settings.py`

---

## DX-10: No run-index convenience commands for migration (HIGH)

**Problem:** Orchestrate's `run-index.sh` provides shortcuts (`report @latest`, `@last-failed`, `stats --session`, `retry @last-failed`) that meridian doesn't have. These are critical for the orchestrate→meridian migration since the orchestrator relies on them to evaluate subagent output.

**Fix:**
- `meridian run report <run-id>` — read a run's report.md directly
- Support `@latest` and `@last-failed` aliases in run ID resolution
- `meridian run create` output should make run ID easy to capture (parseable single-line in porcelain mode)
- Session grouping via `--session` label for related runs

**Files:** `cli/run.py`, `lib/ops/run.py`

---

## DX-11: CLI not self-contained — depends on external skills (HIGH)

**Problem:** `pip install meridian-channel` then `meridian run create` fails if no `.agents/` directory exists. Builtin agent profiles (`agent`, `supervisor`) reference skills that don't ship with meridian (`orchestrate`, `run-agent`, `agent`). The `agent` skill doesn't even exist anywhere.

**Fix:** Bundle default agent profiles and skills as package resources:
```
src/meridian/resources/.agents/
├── agents/
│   ├── agent.md         # default worker behavior
│   └── supervisor.md    # supervisor coordination loop
└── skills/
    ├── supervise/SKILL.md   # replaces "orchestrate" reference
    └── ...
```

Resolution order: user's `.agents/` → meridian's bundled defaults. Rename supervisor skill from `orchestrate` → `supervise`.

**Files:** `lib/config/agent.py:134-170`, new `src/meridian/resources/.agents/`

---

## DX-12: Multi-model fan-out via `-m` (HIGH)

**Problem:** Running the same prompt+skills against multiple models (e.g., for diverse review perspectives) requires separate `meridian run create` calls. The orchestrator composes this manually every time.

**Fix:** Accept comma-separated models in `-m`:
```bash
meridian run create -m codex,sonnet,opus -s reviewing -p "review this code"
```
Spawns one run per model with same skills/prompt. Returns all run IDs. Blocking mode waits for all to finish.

**Files:** `cli/run.py`, `lib/ops/run.py`

---

## DX-13: File operations not split into reads vs writes (HIGH)

**Problem:** `files_touched` extraction (`lib/extract/files_touched.py`) produces a flat list of paths. Doesn't distinguish reads (Read, Glob, Grep) from writes (Edit, Write). Only stores a count in SQLite, not actual paths. A supervisor asking "what did this agent change?" gets the same answer as "what did it look at?" — useless.

**Current state:**
- `extract_files_touched()` is a single generic function parsing all transcript formats
- Each harness has different transcript format (Claude `stream-json`, Codex `output.jsonl`, OpenCode output)
- `HarnessAdapter` protocol has `extract_usage` and `extract_session_id` but no `extract_file_operations`

**Fix:**
1. Add `extract_file_operations` to `HarnessAdapter` protocol:
   ```python
   class FileOperation(NamedTuple):
       path: str
       kind: Literal["read", "write"]

   class HarnessAdapter(Protocol):
       def extract_file_operations(
           self, artifacts: ArtifactStore, run_id: RunId
       ) -> tuple[FileOperation, ...]: ...
   ```
2. Each adapter parses its own transcript format — knows which tool calls are reads vs writes
3. Store both lists in artifacts (not just count in SQLite)
4. Current generic extractor becomes fallback for `DirectAdapter`
5. Surface via `meridian run show <id> --files-written` / `--files-read` (not shown by default)

**Files:** `lib/harness/adapter.py`, `lib/harness/claude.py`, `lib/harness/codex.py`, `lib/harness/opencode.py`, `lib/extract/files_touched.py`

