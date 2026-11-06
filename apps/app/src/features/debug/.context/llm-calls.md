# LLM Calls

The pop-out joins metadata-only gateway lifecycle events with an explicit read of the
canonical request sent to the model. Lifecycle polling stays independent from prompt
capture: model-request content never enters lifecycle events, the trace store,
`EventSink` or JSONL logs.

Prompt content loads only when the user opens a call with both `threadId` and
`turnId`. The endpoint returns the selected request and its immediate predecessor so
the inspector can compare adjacent tool-loop prefixes.

A stop before any output reaches the gateway as `error` with `invalid_request`, the
same as a real bad request, and no gateway record tells them apart. The view joins the
thread snapshot: an `invalid_request` on the last call of a `cancelled` turn shows as
`cancelled`, with the error code still printed beside the badge. `missing_usage` comes
from the paired response's `pricingSnapshot`, so a stop before output (no response row)
can't show it. First output and duration read the close record's
`providerFirstOutputMs` and `gatewayObservationDurationMs`.

A prediction mismatch is a predicted-warm call with an observed reset, or a
predicted-cold call with at least 50% cache reads. Missing cache read data isn't a
mismatch.

The contracts package owns the Markdown projection and prefix summary used by both
this UI and `./mf thread context`. Keep presentation logic there when the UI and CLI
need the same answer.
