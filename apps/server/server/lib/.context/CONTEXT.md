# lib — composition root and route-adjacent infrastructure

`lib/` wires domain ports into Nitro, owns auth and route/WS adapters, and
provides no domain implementation. Concrete adapters are chosen in `compose.ts`;
`domains/` must not import back into `lib/`.

## Composition

`app.ts` owns the process singleton and binds the deferred EventSink and DB.
`compose.ts` constructs production adapters and the typed `AppServices` graph;
`composeAppServices()` is pure service wiring. In-memory composition supplies
explicit test adapters and the same hub aliases as production. Adapter choice,
provider configuration, and disabled behavior stay at this boundary.

The live hub is process-local even though journal rows are durable. The app
singleton keeps one `AppServices` instance across hot reload, and `hub` and
`threadEventHub` are the same alias in production and test composition.

The service graph includes runtime Gateway/orchestrator/runner/claim/tools,
thread repositories/journal/hub/runtime, collab document sync, context ports,
projects/works, billing ledger, immutable Agent revisions and skill installs,
preferences/account settings, observability sink/query, object storage,
interrupts, and model-request debug. Every slot is explicit; no domain falls
back to a process global.

Run preparation uses one composed session registry for writer and child runs.
Child invocation closes over the composed runtime; no second event driver or
bindable proxy exists. Detached work uses the shared tracker.

## Auth, ownership, and tools

`auth-gate.ts` composes WorkOS session validation, user provisioning, and app
services. Route code authenticates first, then uses domain-owned
`requireProjectOwner`/`requireThreadOwner`; document routes and Yjs rooms ask
file-policy for the per-resource grant. `lib` adapts these contracts but does
not own authorization.

Runtime tool definitions and policy live in `domains/runtime`; `lib/model-tools`
binds context, collab, file-policy, and thread services. Document writes pass
through file grants and `@meridian/agent-edit`; URI parsing and document-row
creation remain server-side. `write move` and `write delete` change where a whole
document lives, so the host runs them through the live context port
(`namespace-commands.ts`) and records their tree entry in collab's edit history
inside the mutation's own transaction. Tool handlers return the typed agent-edit result,
and model renderers never replace the persisted typed result. Context-backed
handlers resolve one unified `ContextPort` per call.

## HTTP and WebSocket seams

Routes are thin entry points. Reusable route behavior belongs in testable
`lib/` helpers, and Nitro route tests stay under `lib/routes/` rather than the
production route tree. A normal request is:

```text
Nitro route → requireAppUser → domain ownership gate → file grant → domain port
```

WS upgrades use accept-then-close for rejected connections because the local
Nitro/httpxy path cannot safely return a non-101 upgrade response. Every
classifier-referenced Meridian close pair is registered in `WS_CLOSE`;
transport-local lifecycle closes remain with their transport.

The thread-events WS owns authenticated subscribe, ordered catchup/live
handoff, and cleanup. Every client message but `pong` carries a `requestId`, and
`subscribed`, `gap` and `error` echo it (`subscribed` also states `after`, the
cursor the lease starts above). An omitted cursor resolves to the journal head
after authorization; explicit zero still requests history. Request IDs are 1–64
characters; a message that fails to parse has none to echo.
Messages for different threads proceed concurrently (there is no `resume`). One
per-thread slot admits the newest subscribe by arrival order; a failed replacement
leaves the active lease intact. A failed read after the lease is acquired disposes
it and answers `internal` with `retryable: true`; `not_found`, `bad_request` and
auth stay non-retryable. Pending callbacks
wait until catchup succeeds and are flushed above the delivered watermark;
unsubscribe, replacement, close, and send failure invalidate stale work.
Catalog subscriptions also claim a request slot before reading project ownership.
Close, unsubscribe and a newer request invalidate pending acquisition; only the
current slot can install a listener after that read.
Journal sequence values become strings at the HTTP/WS boundary.

The Yjs handler asks file-policy for `edit`, then `read` for room admission.
Edit frames run under the admitted grant; refusal or Work access change closes
with the typed transport code. Schema admission closes the physical transport
through `closeTransport` after emitting its correlated diagnostic; the hook
throw only aborts processing and is not close delivery. Schema comparison and
head semantics belong to [collab](../../domains/collab/.context/document-authority-and-schema.md).

The client schema comes from `Sec-WebSocket-Protocol`: exactly one grammar
match supplies the triple; absent, zero, or multiple matches use the `0.0.0`
sentinel. The route echoes the sole matching token, otherwise the first offered
token, so the 101 completes and typed refusal can reach malformed clients. No
offered token means no echo, and query parameters do not participate.

## Route-specific contracts

Writer Work rebinds append a durable `work_switched` Notice in the binding
transaction. The hidden system update is appended after the next writer message
and makes the new Work context authoritative on later requests; choosing the
previous Work is an ordinary reverse rebind.

Move requests carry `destinationParent` when they use destination identity.
The route passes that identity into the domain command and receipt, maps typed
`destination_missing` to non-retryable repair, and rechecks edit authority on
the resolved destination under the move transaction. URI-only callers retain
path semantics.

The app's durable namespace queue resends any move, delete or create-untitled it
has not settled, and it settles a refusal only from a typed non-retryable 4xx (the
interrupt envelope, `retryable: false`) or a receipt. Those routes must therefore
answer a deterministic refusal typed. Each route body runs inside
`withDurableIntentInterruptBoundary` (`shared/interrupt-boundary.ts`), which turns
any bare Nitro `HTTPError` 4xx (one thrown without the envelope, such as a parse or
ownership `createError`) into a typed, non-retryable envelope with the same status,
message and `data`. It leaves 401, 408 and 429 bare, so they stay
uncertain and the client retries. A new route that queue replays needs the same wrapper.
A request parser must refuse a malformed identifier itself: a non-UUID Work id, No Work's
id as a Scratch owner, or a chat owner on a scheme that has none is a 400 (`parseWorkId`,
`destinationRootUri`), because a value that reaches the domain or the database fails as an
untyped 500, which the queue retries forever.

A create has no operation receipt: the id the device minted is its receipt. The create-untitled
route reads it first (`answerHeldCreate`, `ContextPort.heldUntitledDocument`), before any
authority or Work-lifecycle check on the destination, so a replay of a create the server took
is answered from what it holds, and a final refusal means the server holds no such id and the
device may place the same id again. An id held where the writer can no longer edit (an
archived Work) answers `409 {status:"conflict"}`, which the device answers by minting a new
identity. An id held in a deleted Work is not found (a deleted Work resolves to no
authority), so its replay is refused `404 work_missing`; its repair answers `conflict`, which
reaches the same remint. Domain failures go through `contextErrorToHttp`, which types every code;
`stale_source`, `stale_target` and `io_error` are the retryable ones. The boundary stays per route rather
than in the global error handler: typing every error there would make a 401
final, and app code on other routes branches on the untyped `HttpResponseError`. Identity conflicts may name a renamed or relocated destination;
URI-only conflicts must still match the requested home. If immutable destination
Work/lineage authority retired before intake, the identity move remains
`destination_missing` even if a folder later relocates. Model tools and `./mf`
currently do not issue moves.

## Dependency direction

```text
lib/* → domains/*, contracts, database, provider/auth/Nitro libraries
      domains/* → (never lib/*)
```
