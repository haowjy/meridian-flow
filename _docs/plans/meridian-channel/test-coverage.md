# Test Coverage — Critical Path Gaps

**Status:** draft

Addresses Gap 16 from post-sandbox review + security audit test needs.

---

## TC-1: Guardrail env isolation

- **File:** `lib/safety/guardrails.py`
- **What:** Test that guardrail subprocesses do NOT inherit parent env secrets
- **How:** Set sentinel env var, run guardrail, assert sentinel absent from subprocess env
- **Depends on:** SEC-1 fix (security-hardening.md)

## TC-2: TTY execvp branch

- **File:** `lib/space/launch.py:387-406` (NOT `exec/spawn.py` — corrected per gap re-review)
- **What:** The TTY-mode execution path using `os.execvp` is untested
- **How:** Mock `os.execvp` and verify correct args when TTY mode detected
- **Challenge:** `execvp` replaces process, must be mocked

## TC-3: DirectAdapter execute/tool loop

- **File:** `lib/harness/direct.py:197-268`
- **What:** Direct adapter's execute -> tool call -> result loop
- **How:** Integration test with mock tool responses, verify loop terminates correctly
- **Note:** Current tests only cover tool definition generation (`tests/test_harness_slice2.py`)

## TC-4: TTY launch env sanitization

- **File:** `lib/space/launch.py:402-405`
- **What:** Verify TTY/execvp path does NOT leak parent env (SEC-2)
- **How:** Mock `os.execvp`, capture env arg, assert no leakage
- **Depends on:** SEC-2 fix

## TC-5: Context pinning path traversal

- **File:** `lib/space/context.py:42-45`
- **What:** Verify `../` paths outside repo root are rejected
- **How:** Attempt to pin `../outside-file.txt`, assert rejection
- **Depends on:** SEC-3 fix

## TC-6: Permission tier -> harness sandbox mapping

- **File:** `lib/safety/permissions.py`
- **What:** Verify `--unsafe` is required when any harness produces `danger-*` sandbox flags
- **How:** Parametrize across tiers and harnesses, assert unsafe requirement
- **Depends on:** SEC-4 fix

## TC-7: Harness passthrough arg validation

- **File:** `lib/space/launch.py:212`
- **What:** Verify dangerous flags in `harness_args` are blocked
- **How:** Attempt `--dangerously-skip-permissions` in passthrough, assert blocked
- **Depends on:** SEC-5 fix

---

## Testing strategy

- Write failing tests FIRST (red), then fix code (green)
- Use `pytest.mark.integration` for subprocess tests
- Use `monkeypatch` for env isolation to avoid test pollution
- Security tests should be FIRST priority — they validate the hardening fixes
