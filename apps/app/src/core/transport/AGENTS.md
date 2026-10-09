# core/transport — Client transport seams

This directory owns browser transport primitives for collaborative documents and
thread/agent sockets. It does not own document-session policy or debug-event
interpretation.

## Mental model

Document and thread sockets expose narrow transport contracts. Optional debug
observers attach through those contracts without becoming part of product
transport behavior.

Document transports keep a merged outbox of local Yjs updates until the current
connection acknowledges them. Reconnect keeps it; a terminal transition freezes
it. Provider-origin updates never enter it. Named close and denial reasons map
through one reset-disposition table, including in-band closes with code 1000.

## Key rules

- New network connections subscribe to injected `ConnectivityHintsPort`; never
  add private window connectivity or wake listeners. The authenticated shell
  owns one source for document, thread, replica, and working-set recovery.

- A `DocumentSessionTransportProvider` must synchronously publish its current
  connection status when `subscribeStatus` is called, then publish every later
  transition.
- Keep document and thread wire contracts separate. Transport observers receive
  final frames but never parse, retain, or broaden their contents.
- Register optional wire taps before a socket can be created; debug features own
  inspection and event construction, not this core directory.

Read [`.context/CONTEXT.md`](.context/CONTEXT.md) for message, status, and
debug-observation contracts.
