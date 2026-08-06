# LLM Calls

The **LLM Calls** pop-out joins metadata-only gateway lifecycle events with an
explicit, content-bearing read of the canonical request sent to the model.
Lifecycle polling must remain independent from prompt capture.

## Data paths

The viewer polls
`/api/debug/events?source=gateway&excludeName=stream.chunk&limit=500` every three
seconds while its window is open. `llm-calls/derive-llm-calls.ts` groups events
by `gatewayCallId`, orders calls newest-first, applies terminal-outcome
precedence, and derives message-class counts from terminal `chunkCounts`.
Individual chunk events never enter the timeline or raw-record view.

Prompt content loads only when the user opens a call with both `threadId` and
`turnId`. The owner-gated model-request endpoint returns the selected request
and its immediate predecessor so the inspector can compare adjacent tool-loop
prefixes. Model-request content never enters lifecycle events, the trace store,
`EventSink`, or JSONL logs.

## Request views

`ModelRequestInspector` presents the provider-neutral `GenerateRequest` in this
order:

1. **Markdown** shows ordered messages and advertised tools. It quotes message
   boundaries and shortens any single extreme part beyond 32 KiB.
2. **Raw** shows the exact captured request JSON.
3. **Debug** shows digests, correlation IDs, prefix evidence, capture status,
   resolved skills, and tool provenance.

The contracts package owns the Markdown projection and prefix summary used by
both this UI and `pnpm --silent debug:model-context`. Keep presentation logic
there when the UI and CLI need the same answer.
