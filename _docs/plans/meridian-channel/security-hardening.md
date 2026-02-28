# Security Hardening

**Status:** draft

Addresses Gap 11 + 10 new findings from comprehensive security audit (2026-02-27).

---

## SEC-1: Guardrail environment leakage (Gap 11)

**Severity:** CRITICAL

**Problem:** `run_guardrails()` passes `os.environ.copy()` to guardrail subprocess, leaking full parent env (API keys, tokens) to untrusted guardrail scripts.

**Fix:** Route through `sanitize_child_env()`. Only pass PATH, HOME, LANG + guardrail-specific config vars.

**Files:** `lib/safety/guardrails.py:71-76`
**Test:** Set `LEAK_ME=secret`, run guardrail, assert absent. Confirmed leakage via probe.

---

## SEC-2: TTY space launch bypasses env sanitization

**Severity:** CRITICAL
**Source:** Security audit

**Problem:** In TTY mode, `os.environ.update(child_env)` merges sanitized env INTO the full parent env instead of replacing it. Non-allowlisted secrets remain visible to the supervisor subprocess.

**Fix:** In TTY/execvp path, build a clean env dict and use `os.execvpe()` with explicit env, or clear parent env before merge.

**Files:** `lib/space/launch.py:402-405`

---

## SEC-3: Context pinning allows out-of-repo file inclusion

**Severity:** CRITICAL
**Source:** Security audit (confirmed via runtime probe)

**Problem:** `../` traversal can pin files outside repo root. `_to_relative` fallback (`../<basename>`) makes this non-obvious. Pinned file contents are injected into resume prompts.

**Fix:** Validate pinned paths are within repo root. Reject or warn on paths that resolve outside space.

**Files:** `lib/space/context.py:42-45,129-137`, `lib/adapters/sqlite.py:138-142`

---

## SEC-4: --unsafe bypassed for dangerous sandbox values

**Severity:** MAJOR
**Source:** Security audit (confirmed via runtime probe)

**Problem:** `danger-full-access`/`unrestricted` maps to `full-access` tier, which doesn't require `--unsafe`. But Codex `full-access` yields `--sandbox danger-full-access` — effectively dangerous without confirmation.

**Fix:** Require `--unsafe` for any tier that produces `danger-*` sandbox flags in any harness.

**Files:** `lib/safety/permissions.py:77-83,136-139,247`

---

## SEC-5: Harness passthrough args can override permission safety

**Severity:** MAJOR
**Source:** Security audit (confirmed via runtime probe)

**Problem:** `harness_args` (MCP-exposed) are appended directly to launch command. Caller can pass `--dangerously-skip-permissions` or similar.

**Fix:** Validate/blocklist passthrough args against known dangerous flags per harness. Or remove passthrough from MCP surface entirely.

**Files:** `lib/ops/space.py:31-33,53`, `lib/space/launch.py:212`

---

## SEC-6: MCP repo_root is unsandboxed

**Severity:** MAJOR
**Source:** Security audit

**Problem:** MCP tool callers can set `repo_root` to arbitrary directories, breaking space containment.

**Fix:** Lock `repo_root` to the server's configured space on MCP surface. CLI can still override.

**Files:** `lib/ops/_runtime.py:43-45`, all MCP input dataclasses

---

## SEC-7: Arbitrary file read via run references

**Severity:** MAJOR
**Source:** Security audit (confirmed — loaded `/tmp/secret.txt` into prompt)

**Problem:** `run_create` reference files and template vars can load absolute paths outside space into prompt context.

**Fix:** Validate reference paths are within repo root (or explicitly allowed via config).

**Files:** `lib/ops/_run_prepare.py:230-231`, `lib/prompt/reference.py:68-73,108-113`

---

## SEC-8: API credentials not auto-redacted in artifacts

**Severity:** MAJOR
**Source:** Security audit (confirmed — `ANTHROPIC_API_KEY` in `output.jsonl`)

**Problem:** If harness/model outputs env values, provider API keys persist unredacted in run artifacts. Redaction only applies to explicit `secrets` config.

**Fix:** Auto-redact known provider key patterns (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.) from output artifacts. Apply same redaction to `output.jsonl` and `stderr.log`.

**Files:** `lib/exec/spawn.py:78-96,197,243`, `lib/extract/finalize.py:60`

---

## SEC-9: Wildcard MCP tool names accepted from profiles

**Severity:** MAJOR
**Source:** Security audit (confirmed — `mcp__meridian__*` in command)

**Problem:** Profile `mcp-tools: [*]` becomes `mcp__meridian__*`, broadening tool access beyond explicit allowlist intent. Unknown tool names warned but kept.

**Fix:** Reject wildcard patterns. Require explicit tool enumeration.

**Files:** `lib/config/agent.py:84-91`, `lib/harness/claude.py:106-108`

---

## SEC-10: Pinned context injected as trusted prompt without containment

**Severity:** MAJOR
**Source:** Security audit

**Problem:** Model-generated files (e.g., reports) can be pinned and re-injected as high-trust instructions on fresh resume. No `sanitize_prior_output()` boundaries applied.

**Fix:** Wrap pinned context in containment markers (similar to prior-output boundaries). Warn if pinned files are outside repo root.

**Files:** `lib/space/context.py:129-137`

---

## SEC-11: SQLite connection hardening inconsistent

**Severity:** MINOR
**Source:** Security audit

**Problem:** Several paths use raw `sqlite3.connect()` bypassing `open_connection()` (which sets busy-timeout, WAL, PRAGMAs). No SQLi found, but contention failures possible.

**Fix:** Route all SQLite access through `open_connection()`.

**Files:** `lib/space/summary.py:27,112,144`, `lib/ops/run.py:230`, `lib/ops/_run_query.py:20`

---

## Implementation priority

1. **SEC-1, SEC-2** (CRITICAL env leaks) — fix immediately
2. **SEC-3** (path traversal) — fix immediately
3. **SEC-4, SEC-5** (permission bypasses) — fix before any external use
4. **SEC-6, SEC-7** (containment breaks) — fix before MCP exposure
5. **SEC-8, SEC-9, SEC-10** (defense in depth) — next pass
6. **SEC-11** (hardening) — low priority
