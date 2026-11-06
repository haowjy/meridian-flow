# client/working-set

Device-local recent document routes with optional cross-device sync. It can rank
already-open Editor tabs but never creates workspace membership.

- Build routes with `buildWorkingSetRoute`, not by hand. Every server route needs
  its stable document ID, and Work-capable schemes need real Work or No Work
  authority.
- The server row is the cross-device subset of at most three routes, not the full
  Editor workspace. A new state kind gets its own record and policy; don't grow
  this into a general sync engine.

Depth: [.context/CONTEXT.md](.context/CONTEXT.md). Deferred work:
[.context/TODO.md](.context/TODO.md).
