# Slice 5a: Post-Execution + Extraction

**Required reading:**
- [`_docs/plans/meridian-channel/README.md`](../README.md) (always)
- [`_docs/plans/meridian-channel/design-philosophy.md`](../design-philosophy.md) (always)
- [`_docs/plans/meridian-channel/architecture.md`](../architecture.md) (storage protocols)

**Effort:** 1.5 days
**Dependencies:** Slice 4 (execution engine), Slice 2 (HarnessAdapter), Slice 1 (state layer).
**Model recommendation:** `gpt-5.3-codex`

## Description

Implement cross-harness token/cost extraction, files-touched extraction, report extraction/fallback, finalize row enrichment, and error classification. Fixes gap #4 (no cost tracking for Codex/OpenCode).

## Files to create

- `src/meridian/lib/extract/files_touched.py` — file path extraction
- `src/meridian/lib/extract/report.py` — report.md extraction/fallback
- `src/meridian/lib/extract/finalize.py` — extraction pipeline orchestration
- `src/meridian/lib/exec/errors.py` — error classification (retryable vs unrecoverable)

## Error classification (lesson learned from agent retry loops)

```python
from enum import StrEnum

class ErrorCategory(StrEnum):
    RETRYABLE = "retryable"           # transient: rate limits, network, temp lock
    UNRECOVERABLE = "unrecoverable"   # token limit, model not found, permission denied
    STRATEGY_CHANGE = "strategy_change"  # output too large, context too long

def classify_error(exit_code: int, stderr: str) -> ErrorCategory:
    """Classify harness error to determine retry strategy.
    Unrecoverable errors should NOT be retried — report failure immediately."""
    ...
```

## Extraction pipeline

```python
async def enrich_finalize(run: Run, registry: HarnessRegistry, artifacts: ArtifactStore) -> None:
    adapter = registry.get(run.harness)
    usage = adapter.extract_usage(artifacts, run.id)
    session_id = adapter.extract_session_id(artifacts, run.id)
    files = extract_files_touched(artifacts, run.id)
    report = extract_or_fallback_report(artifacts, run.id)
    state.enrich_finalize_row(run.id, usage, session_id, len(files), report is not None)
```

## Acceptance criteria

1. Claude/Codex/OpenCode adapter `extract_usage()` works from fixture outputs
2. Report fallback extracts last assistant message when report.md missing
3. Empty output detected and run marked as failed
4. Finalize row enriched with tokens, cost, session ID, files-touched count
5. Error classification correctly categorizes token limits, model errors, network errors
6. Unrecoverable errors not retried (max 3 retries for retryable only)
7. Unit tests for extraction + error classification
