# domains/undo-notifications

Tiny server-owned delivery queue for telling the runtime that a writer reversed
assistant edits before the next message. Collab records rows after successful
user reversals; runtime consumes and clears rows once at `runTurn` start.

Keep this domain storage-only. It must not know agent-edit internals, model
prompt formatting, or route/UI concerns.
