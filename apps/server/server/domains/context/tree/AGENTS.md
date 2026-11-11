# domains/context/tree

Contract: [local contract](.context/CONTEXT.md).

- Only `tree-view-sql.ts` reads hidden columns; other readers take a `TreeView`.
- Lock order: in-process leases, Work/branch rows, namespace locks, then document
  locks in sorted order. Compute namespaces before taking document locks.
- End hidden nodes as tombstones, not deletes, so bound links retain `gone`.
- Namespace lifecycle changes bump `location_version`. Identity destinations
  resolve in the live view.
- Tree writes return changed identities; their caller refreshes the catalog in
  the same transaction.
