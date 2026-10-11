# Resource replica

Pure resource metadata policy belongs here; browser storage, HTTP, Yjs session
objects, React and navigation belong in app adapters. Consumers use the package
public export rather than reaching into its implementation.

Catalog replay installs whole commits. Its cursor and entries describe one
checkpoint; a scope entry disappearing does not prove that a document was
deleted globally. Resource content has its own Yjs persistence authority.

Namespace intent `settled` means accepted by the server. Rejected work retired
by a later command (including a reminted create conflict) is terminal
`superseded`: retain its attempts as evidence, never as executable work or
placement/deletion ownership.

Typed non-retryable HTTP 4xx refusals also settle namespace attempts when route
intake rejects before a server receipt exists. Persist that refusal against the
submitted operation ID, never invent a server receipt. Bare HTTP/network failures
still need receipt evidence and remain replayable otherwise.

File location intents retain `typedName` independently of their canonical optimistic
destination. Dispatch sends the typed name so an explicit prose suffix cannot be
misread as source-extension inheritance. Receipt commands witness typed requests;
the receipt result and optimistic location carry canonical stored names.
