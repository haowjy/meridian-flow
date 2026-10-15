# domains/context/tree — visibility and hidden-node lifecycle

This module owns the `TreeView` for live and Work-draft reads, node identity
placement, and hidden-node create/reveal/end-of-use/repair. Read the [local
contract](.context/CONTEXT.md) before changing tree behavior.

The hidden predicate has one owner: `tree-view-sql.ts` reads hidden columns;
the lifecycle writers insert or reveal them. Other readers take a `TreeView`,
never a raw hidden column.

- Acquire in-process leases, Work/draft rows, namespace locks, then document
  locks in sorted order. Compute namespaces before taking document locks.
- End hidden nodes as tombstones, not deletes, so bound links retain `gone`.
- A draft create starts with empty live content; its text exists in the branch
  until Apply. Namespace lifecycle changes bump `location_version`.
- Tree writes return changed identities; their caller refreshes the catalog in
  the same transaction. Identity destinations resolve in the live view.

The parent domain owns URI and access policy; this module only decides tree
visibility and placement. Keep catalog refresh and document derivation in the
caller that owns the surrounding transaction.
