# agent-edit — contracts and architecture

Read the page that owns the seam you are changing:

- [Port contracts](port-contracts.md): what a host must do that the port types can't say.
- [Write architecture](write-architecture.md): planning, capture, targeting and results.
- [Link identity](link-correspondence.md): ref assignment at every write door.
- [Diff review](diff-review.md): pure text review, composition, rebase and local Discard.

Deferred work is in [TODO.md](TODO.md) and [FUTURE.md](FUTURE.md); rejected
directions are in [ALTERNATIVES.md](ALTERNATIVES.md).

## Pinned reconstruction adapter

`src/yjs-mutation.ts` holds every mechanic that depends on Yjs internals, which is
why `yjs` is exactly pinned in `package.json`. Keep version-sensitive
reconstruction here rather than in app or undo copies. Hosts choose operations,
supply identity mapping and own transactions; the adapter copies an item's own
content, never its descendants.

## Forward-inverse dependency closure

A forward inverse closes over one Yjs dependency predicate: the selected edit's
retained structures and everything that depends on them. Review grouping and the
model's text-derived status never use this predicate.
