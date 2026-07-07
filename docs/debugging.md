# Debugging

Use temporary console probes when they help you understand a live bug quickly.
Keep them disposable: delete them before pushing, or convert useful signals into
durable observability through the server `EventSink`.

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
- Pre-push blocks `TEMP-DEBUG`, `[temp-debug:...]`, `console.log(`, and
  `console.debug(` in product source, even when the console call is unmarked.
- Do not log secrets, cookies, raw prompts, raw model output, uploaded content,
  tool arguments, or tool results.
- Remove the probe before pushing, or convert it into durable observability.

## Durable Logs

If the signal would help another agent tomorrow, use structured observability
instead of `console.log`.

- Server diagnostics go through `EventSink` / `emitEvent`.
- In local dev, `pnpm dev` defaults `LOG_DIR` to `logs/events/` so structured
  events are mirrored to `logs/events/YYYY-MM-DD.jsonl` in addition to interleaved
  stdout in `logs/portless.log`. Review later: structured events are in
  `logs/events/*.jsonl`.
- Model-request diagnostics can use the existing model-request debug capture
  path when that is the right level of detail. Broader prompt and agent-run
  trace capture is not implemented yet; until it exists, use safe metadata in
  `EventSink` events and keep protected content out of ordinary searchable logs.
- Client-only probes can use temporary console output while diagnosing; durable
  client diagnostics need an explicit dev/debug transport before they become
  observable to LLMs.

## Cleanup

Find the same product-source patterns that pre-push blocks:

```bash
node tools/ci/check-debug-probes.mjs
```

Pre-push runs `node tools/ci/check-debug-probes.mjs` and blocks temporary probes
in product source. The fix is to delete the probe or convert it to durable
observability.
