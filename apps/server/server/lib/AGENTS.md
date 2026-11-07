# server/lib — composition and transport entry points

Composition root and route- and WebSocket-adjacent infrastructure. Domains don't
import from here. Depth: [`.context/CONTEXT.md`](.context/CONTEXT.md).

## Key rules

- Accept a rejected WebSocket upgrade, then close with a registered code and reason:
  Nitro development infrastructure can't safely return a non-101 response. Emit an
  error frame first only when that WebSocket protocol defines one.
- Define every Meridian close pair a classifier uses in `WS_CLOSE`, and reference it
  from there. Transport-local lifecycle and failure closes stay with the transport
  that emits them.
