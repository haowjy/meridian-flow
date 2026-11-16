# mcp — a writer's connections to remote MCP servers

A connection is a writer's saved address (and optional token) for a remote MCP server, at one
level: the account (`project_id` null) or one project. The shared client
(`@meridian-flow/runtime/mcp`) does the protocol; this domain owns what Flow stores and when it
asks. The tools, the prompt catalogue and the call records are the runtime's and are built on top
of this ([design](https://github.com/haowjy/meridian-flow-docs/tree/main/work/shared-mcp-design/design)).

## What is stored

- `mcp_connections`: name (letters, digits, `-`, `_`; unique among live rows of its level: add and
  Undo never refuse a name taken there, they take the next free `<name>-2`, `-3`…, and there is no cap on
  how many connections a writer has), a
  transport-tagged `spec`, the current pin, a **settings version**, soft delete, and the status
  columns ([state machine](state-machines.md)). Removal is soft so Undo brings back the pin and
  the token. A sweep on the recovery scheduler (`mcp-removed-purge`) deletes a connection removed
  more than 30 days ago, with its pins and token; its `mcp_calls` rows stay with their chats.
- `mcp_pins`: insert-only (a trigger, as for `prompt_bakes`); a re-pin is a new row. A thread's
  bake will hold pin ids, so a pin's bytes never change.
- `mcp_connection_tokens`: keyed on (connection, account), AES-256-GCM under `MCP_TOKEN_KEY`
  (`domain/token-cipher.ts`). The ciphertext is bound to its connection and account. A token is
  never sent to the app (the list says "set" or "not set") and never logged. A key that no longer
  opens a token makes the connection `needs_sign_in` with its own reason, not an error. Losing
  the key means every writer enters their tokens again.
- `mcp_calls`: one row per connection call (thread, turn, model response, tool call, sequence,
  connection, pin, tool, arguments as sent, outcome, reply reference, sent and finished times).
  Plain ids, so a row outlives its connection; the chat's delete takes the rows.

## Rules a wrong edit breaks

- **One resolution.** `resolveByName` (and `service.resolve`) is the only place the account's and
  the project's connections are put in order and shadowed: the project's connection wins a name,
  the account's is listed as shadowed. The settings list and the prompt bake both read it.
- **The session key is account + connection + settings version** (`lib/mcp-client.ts`
  `sessionKey`). An edit of the address or the token bumps the version, so every server process
  stops using the old session at once; the process that handled the edit also closes it. The
  one process-wide client lives in `lib/`, over Flow's `fetch` on the public-address dispatcher
  (https, port 443, no redirects, HTTP/1.1 only through `lib/outbound-http1.ts`, which every outbound request shares; `addressRefusal` in `lib/mcp-client.ts` is the one rule for the address, applied by `publicFetch` to each request and by the service at add and edit, so an address Flow will never contact is refused on the screen at once, not saved; a redirect is refused with a reason of its own: undici's HTTP/2 path leaves an orphan stream after an aborted request, whose idle close throws an uncaught `UND_ERR_INFO`, nodejs/undici#6143). Domains never import `lib/`, so the service takes the client
  and the key function as dependencies.
- **A connection may be saved with no pin.** Adding lists the server's tools; with no answer the
  connection is saved with no pin and the status says why. An edit of the address drops the pin
  (it listed another server) and, in the background, pins again what the new server lists of the
  tools the writer had chosen (read-only ones); a server that cannot be listed leaves no pin, and
  the screen offers Choose tools. Only read-only tools can be pinned
  until the owner decides how calls with effects are held.
- **Starting a chat never waits for a check**, and a check runs no tool.

## The tools and the bake

`mcp_describe`, `mcp_call` and `mcp_run` are three fixed tools (`source: "mcp"`, in `TOOL_CATALOG`); a chat's
connections are prompt text, not tool definitions.

- **A thread's pins live in its prompt bake.** `prompt_bakes.baked_connections` holds, for each
  connection, the name the thread knows it by, the connection id, the pin id and how it was listed
  (`full` or `by_name`). It is in the bake's content hash, so a changed pin makes a new bake. The
  catalogue is one section of `composedSystemPrompt` (`domain/connection-bake.ts`). It is written,
  and `baked_connections` filled, only when the thread's tool policy includes `mcp_call`: an Agent
  that denies it never reads the writer's connections or their descriptions.
- **Which bake reads what.** A new chat, a handoff that does not reuse its source's bake, and every
  compaction read the connections now, the project's over the account's (`resolveByName`). A
  subagent takes its parent's bake in effect, at each prompt it writes (first turn and each
  compaction), so a connection added since is not offered to it. A fork inherits the bake. No
  network call is made while a bake is composed or saved; saving a prompt starts the checks its
  connections are due (`saved`), in the background, after the transaction that saved it commits
  (`afterCommit`), so a rolled-back bake starts none.
- **Listed by name.** A connection whose status is needs sign-in, or unreachable from a check that
  started within two minutes (`status_started_at`: a later check that learned nothing, a rate
  limit, does not make an old failure look fresh), is one line with the reason and no tool lines. `mcp_describe` with its
  name lists its tools from the pin, and `mcp_call` goes out whatever the status.
- **`callConnectionTool`** (`domain/connection-tools.ts`) is the one function that calls a
  connection's tool, and a script's call will use it too. It reads the pin through the bake, writes
  the `mcp_calls` row on the plain `db` (never the ambient transaction) before the client is
  called, completes it after, keeps the full reply in the chat's storage prefix
  (`chat-media/<thread>/mcp/`, which the Work purge clears), and feeds the connection's status
  (`checks.recordCall`). Nothing that calls a connection may run inside a longer transaction: the
  row must be committed the moment the call leaves. Once the client has answered, nothing throws
  before the outcome reaches the model, or it would repeat a call that ran: keeping the reply
  (and each picture) is best-effort (a failed store is noted on the row as `reply_ref`
  `{notKept}`, the picture is left out and said so), and completing the row and feeding the status
  warn (`McpCallAfterAnswerFailed`) and carry on.
- **Results.** Each outcome has its own code (`mcp_tool_error`, `mcp_rejected`, `mcp_too_large`,
  `mcp_unreachable`, `mcp_unauthorized`, `mcp_aborted`, `mcp_unknown_tool`,
  `mcp_connection_removed`); the typed result (`@meridian/contracts/mcp`) names connection, tool,
  outcome, the arguments sent, the record id and the reply the model read. A reply is cut at 24,000
  characters with a line saying so. A tool's own error or a rejection is followed by the tool's
  schema. Pictures are stored in the chat's prefix and travel as stored media parts. An id the
  thread does not hold, and a connection removed since, are made without calling the client.
- **Restart.** The request-time stub for a connection call with no stored result opens with
  `DO_NOT_REPEAT`, the text a failed script's list opens with too, and lists its records: each
  call as the id `mcp_call` takes (`<connection>/<tool>`, the name from the thread's bake), what
  was sent, and whether it was answered (its reply is kept, not shown) or its end was not
  recorded and it may have run. It is never sent again.
- **`mcp_run`** (`domain/script-run.ts`) runs the model's JavaScript on the one QuickJS runner made
  in `createAppServices` and closed at shutdown; it throws at creation when the bundle lost the
  runner's worker or `.wasm`, so `pnpm smoke:prod-boot` proves the build (Nitro `traceDeps` holds
  all of `@meridian-flow/runtime` external for it). A script's `call(id, args)` is `callConnectionTool`
  with `sequence` counting up from 0, so records, rules and outcomes are `mcp_call`'s. On the MCP
  side: 8 calls in flight a script, 2 scripts an account (a third waits; the limiter lives in this
  process), 2 MB a reply and 8 MB a script into the script, media left out and said so in the
  value. Code goes through `script-code.ts` first (fences off, types stripped in place by Node's
  `stripTypeScriptTypes`, so an error's line is the line the model wrote). The result text is the
  value, the calls, the logs; a script that did not return also lists each call's arguments and
  reply and says not to repeat answered calls (without that, models repeated writes); a call
  refused before it was sent is listed apart, as not run. Each call is
  journaled as `tool.connection_call` (sent, then finished) for the chat's live rows; the final
  typed result (`McpRunResult`) lists every call. Limits are `SCRIPT_LIMITS`, which the tool
  description reads.
- **After a compaction** each `mcp_describe` emits `McpDescribeAfterCompaction` (source
  `mcp.describe`, `responseId`, `names`, `ms`). The round trip it adds is the model response that
  issued it, so `model_responses.latency_ms` on `responseId` gives the time to sum (owner question
  12 waits on this number).
