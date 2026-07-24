# LLM Calls viewer

The **LLM Calls** action opens a sibling pop-out to Streams using the shared
`DebugPopout` lifecycle and copied document chrome. Its only default data source
is the metadata-only same-origin query
`/api/debug/events?source=gateway&excludeName=stream.chunk&limit=500`.
Excluding verbose records before the query limit keeps lifecycle polling
independent of long generations. The viewer polls every three seconds while
its popup is mounted; closing the popup unmounts the viewer, clears the interval,
and aborts the active query.

`llm-calls/derive-llm-calls.ts` is the pure projection boundary. It groups by
`correlation.gatewayCallId`, orders calls newest-first, resolves terminal
outcome precedence, and collapses verbose chunk records into message-class
counts. The normal lifecycle query derives those counts from terminal
`chunkCounts`; direct verbose-record projection remains a compatibility path.
Timeline and raw-record views exclude individual chunks so verbose capture
cannot create hundreds of rows.

Gateway events and the initial call render remain metadata-only. Prompt and
parameter content has one path: an explicit per-call action calls the existing
owner-gated thread model-request endpoint when both `threadId` and `turnId` are
present. The returned records render only inside that expanded call detail and
never join the polling response or trace store.
