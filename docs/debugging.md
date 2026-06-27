# Debugging

Use temporary console probes when they help you understand a live bug quickly.
Keep them disposable: delete them before pushing, or convert useful signals into
durable observability through the server `EventSink` or agent debug trace
capture.

## Temporary Probes

Use this exact shape:

```ts
// TEMP-DEBUG: remove before push
console.log("[temp-debug:runtime.turn]", { threadId, turnId, state });
```

Rules:

- Put `// TEMP-DEBUG: remove before push` immediately above the console line.
- Prefix the message with `[temp-debug:<area>]`.
- Log one compact metadata object.
- Do not log secrets, cookies, raw prompts, raw model output, uploaded content,
  tool arguments, or tool results.
- Remove the probe before pushing, or convert it into durable observability.

## Durable Logs

If the signal would help another agent tomorrow, use structured observability
instead of `console.log`.

- Server diagnostics go through `EventSink` / `emitEvent`.
- Prompt and agent-run diagnostics should go through the agent debug trace
  capture path, not ordinary searchable logs.
- Client-only probes can use temporary console output while diagnosing; durable
  client diagnostics need an explicit dev/debug transport before they become
  observable to LLMs.

## Cleanup

Find temporary probes:

```bash
rg -n "TEMP-DEBUG|\\[temp-debug:|console\\.log\\(|console\\.debug\\(" apps/app/src apps/server/server packages
```

Pre-push runs `node tools/ci/check-debug-probes.mjs` and blocks temporary probes
in product source. The fix is to delete the probe or convert it to durable
observability.
