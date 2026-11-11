# @meridian/server

Nitro API and WebSocket service. Composition, transport and cross-domain
contracts: [server architecture](.context/CONTEXT.md).

- A route that reads or changes a document also asks the
  [file policy](server/domains/file-policy/.context/CONTEXT.md): project
  ownership says nothing about archived Work or deleted files.
- A new write seam starts its transaction with `lockSeamWorks` before any
  advisory or document lock; the reverse order can deadlock archive or purge.
- Run independent reads with `Promise.all`, inside a transaction too. Work meant
  to outlive the transaction leaves it with `runAfterDrizzleCommit` or
  `runOutsideWrite`; other database work still running after it ends throws.
- DB tests: [isolation policy](server/test-support/AGENTS.md).
