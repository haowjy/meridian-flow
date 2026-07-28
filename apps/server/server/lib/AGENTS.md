# server/lib — composition and transport entry points

`lib/` assembles server domains into the Nitro application and owns route- and
WebSocket-adjacent infrastructure. It is not a domain: domains must never
import from it.

## Mental model

`compose.ts` chooses concrete adapters and builds the pure service graph;
`app.ts` owns process-lifetime caching and bindings. Routes authenticate, gate
ownership, then delegate to a domain. WebSocket handlers bridge authenticated
peers to domain-owned collaboration and thread services.

## Key rules

- Keep adapter choice and provider configuration at this composition boundary.
- Keep route files thin; place reusable route logic in testable `lib/` helpers.
- Accept rejected WebSocket upgrades, then close with a registered code/reason:
  Nitro development infrastructure cannot safely return non-101 responses.
  Emit an error frame first only when that WebSocket protocol defines one.
- Every Meridian WebSocket close pair used by a classifier is defined in
  `WS_CLOSE`; classifiers reference registry entries. Transport-local lifecycle
  and failure closes remain owned by their emitting transport.
- Preserve the dependency direction `lib/ → domains/`; domain code must not
  reach back into this directory.

Read [`.context/CONTEXT.md`](.context/CONTEXT.md) for service slots, route
helpers, WebSocket roles, and operational invariants.
