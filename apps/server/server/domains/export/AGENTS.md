# Project export

Export reads live documents, not Work drafts. A request captures the inventory,
canonical addresses and ahead settlements before reading any content. Layout
and link spelling use that captured identity map for the whole ZIP, even if
files move while it streams. Mechanism, routes and preview:
[.context/CONTEXT.md](.context/CONTEXT.md).

- Documents stream in tree order (project sibling order, `compareCatalogSiblings`
  from `@meridian/resource-replica`, applied in
  `../context/tree/export-inventory.ts`). `buildExportLayout` does not sort: the
  first sibling to claim a name keeps it.
- The snapshot adapter takes a short repeatable-read snapshot, never a transaction
  spanning a download. It reads canonical addresses through Context's public
  index (`loadDocumentAddresses`), not its private adapters.
- The service filters through file policy and live manifest membership. Archived
  Work files stay readable and are included when selected.
- Never gather a file's or the project's bytes: a stored binary is piped from
  `ObjectStorePort.getStream` into its zip entry.
- Ordinary and model serialization must never use the export codec. Export owns
  `ExportLinkScope` and reads through `ExportDocumentReader`, adapted from
  Collab's export read door in `lib/compose.ts`; Collab owns the codec, not
  archive policy.
- The export codec writes wiki-style literals verbatim (wikilinks, embeds, callout
  markers, footnotes) so the folder reopens in a Markdown note app; everything else
  that could form a link stays escaped. Reparsing an export must find exactly the
  document's links.
- The `meridian-export.json` marker's shape, filename, default area names and
  parser live in `packages/contracts/src/export-marker.ts`; import (server and
  app) reads it through that parser.

Deferred work: [TODO](.context/TODO.md).
