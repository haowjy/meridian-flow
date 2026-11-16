# mcp: deferred work

- **A typed error for a refusal by Flow.** `isRefusedByFlow` in `domain/connection-checks.ts`
  matches the refusal's text (`REFUSED_BY_FLOW`) because a refusal crosses the client as a
  failed-start message. The client should return a typed reason instead; that change belongs in
  the `meridian-runtime` client (`@meridian-flow/runtime/mcp`), after which the regex goes. Until
  then, rewording a refusal in `lib/mcp-client.ts` breaks the match silently.
