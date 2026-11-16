# mcp — a writer's connections to remote MCP servers

A connection is a writer's saved address (and optional token) for a remote MCP server, at one
level: the account (`project_id` null) or one project. The shared client
(`@meridian-flow/runtime/mcp`) does the protocol; this domain owns what Flow stores and when it
asks. The tools, the prompt catalogue and the call records are the runtime's and are built on top
of this ([design](https://github.com/haowjy/meridian-flow-docs/tree/main/work/shared-mcp-design/design)).

## What is stored

- `mcp_connections`: name (letters, digits, `-`, `_`; unique among live rows of its level), a
  transport-tagged `spec`, the current pin, a **settings version**, soft delete, and the status
  columns ([state machine](state-machines.md)). Removal is soft so Undo brings back the pin and
  the token. Nothing purges removed rows yet.
- `mcp_pins`: insert-only (a trigger, as for `prompt_bakes`); a re-pin is a new row. A thread's
  bake will hold pin ids, so a pin's bytes never change.
- `mcp_connection_tokens`: keyed on (connection, account), AES-256-GCM under `MCP_TOKEN_KEY`
  (`domain/token-cipher.ts`). The ciphertext is bound to its connection and account. A token is
  never sent to the app (the list says "set" or "not set") and never logged. A key that no longer
  opens a token makes the connection `needs_sign_in` with its own reason, not an error. Losing
  the key means every writer enters their tokens again.
- `mcp_calls`: the table only. The call records' writes belong to the tools.

## Rules a wrong edit breaks

- **One resolution.** `resolveByName` (and `service.resolve`) is the only place the account's and
  the project's connections are put in order and shadowed: the project's connection wins a name,
  the account's is listed as shadowed. The settings list and the prompt bake both read it.
- **The session key is account + connection + settings version** (`lib/mcp-client.ts`
  `sessionKey`). An edit of the address or the token bumps the version, so every server process
  stops using the old session at once; the process that handled the edit also closes it. The
  one process-wide client lives in `lib/`, over Flow's `fetch` on the public-address dispatcher
  (https, port 443, no redirects). Domains never import `lib/`, so the service takes the client
  and the key function as dependencies.
- **A connection may be saved with no pin.** Adding lists the server's tools; with no answer the
  connection is saved with no pin and the status says why. Only read-only tools can be pinned
  until the owner decides how calls with effects are held.
- **Starting a chat never waits for a check**, and a check runs no tool.
