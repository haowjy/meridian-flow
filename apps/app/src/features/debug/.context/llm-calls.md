# LLM Calls

The pop-out joins metadata-only gateway lifecycle events with an explicit read of the
canonical request sent to the model. Lifecycle polling stays independent from prompt
capture: model-request content never enters lifecycle events, the trace store,
`EventSink` or JSONL logs.

Prompt content loads only when the user opens a call with both `threadId` and
`turnId`. The endpoint returns the selected request and its immediate predecessor so
the inspector can compare adjacent tool-loop prefixes.

A prediction mismatch is a predicted-warm call with an observed reset, or a
predicted-cold call with at least 50% cache reads. Missing cache read data isn't a
mismatch.

The contracts package owns the Markdown projection and prefix summary used by both
this UI and `./mf thread context`. Keep presentation logic there when the UI and CLI
need the same answer.
