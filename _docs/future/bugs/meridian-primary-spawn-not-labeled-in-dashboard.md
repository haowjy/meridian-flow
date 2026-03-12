---
detail: minimal
audience: developer
---

# Primary agent spawn shows as unlabeled orphan in dashboard

## Summary

When a primary agent (orchestrator) is spawned via `meridian spawn`, it appears in `meridian work` and `meridian spawn list` as an unlabeled running spawn with no work item. This makes it look like a stale or orphaned process.

## Observed behavior

```
ACTIVE
  websocket-transport-v2  Phase 0 complete. Starting Phase 1A + 1B (parallel)
    p85  claude-sonnet-4-6  running  smoke-tester: document WS endpoint probes

  (no work)
    p53  claude-opus-4-6  running    <-- this is the orchestrator
```

p53 is the primary agent orchestrating the entire ws-transport-v2 work item. It has no `--work`, no `--desc`, no `params.json`, and no `prompt.md` — just a 953K-line `output.jsonl`. Child spawns (p79-p85) are correctly associated with the work item, but the parent is not.

## Expected behavior

The primary spawn should be associated with its work item and labeled as the orchestrator:

```
ACTIVE
  websocket-transport-v2  Phase 0 complete. Starting Phase 1A + 1B (parallel)
    p53  claude-opus-4-6    running  (primary)
    p85  claude-sonnet-4-6  running  smoke-tester: document WS endpoint probes
```

## Two issues

1. **No work item association** — the primary spawn is not linked to the work item it's orchestrating, so it falls under "(no work)".
2. **No label** — there's no desc or role indicator to distinguish it from child spawns. Should be labeled as primary/orchestrator.
