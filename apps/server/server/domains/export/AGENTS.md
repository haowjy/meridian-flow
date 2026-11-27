# Project export

Export reads live documents, not Work drafts. A request captures the inventory,
canonical addresses and ahead settlements before reading any content. Layout
and link spelling use that captured identity map for the whole ZIP, even if
files move while it streams. Mechanism, routes and preview:
[.context/CONTEXT.md](.context/CONTEXT.md).

- Documents stream in tree order (project sibling order, `compareCatalogSiblings`
  from `@meridian/project-tree`, applied in
  `../context/tree/export-inventory.ts`). `buildExportLayout` does not sort: the
  first sibling to claim a name keeps it. It finds every entry before naming
  any, then names each folder's children the same way, folders and files
  together: every entry claims its own name first, and only the clashes left
  over are numbered, with `numberedName` from `@meridian/contracts/protocol`
  (before the last extension for a file). A numbered twin never displaces an
  entry really named `x (2)`. Names are written in NFC and compared ignoring case
  and normalisation, as macOS and Windows unpack them.
- The archive holds every visible folder, empty ones as directory entries: the
  inventory returns folders with their addresses beside documents, so a writer's
  empty `Arc 2` survives a backup. Folders come before files in naming, so a
  folder keeps a name it shares with a file.
- Every ZIP entry is marked as made on Unix with a file mode (`zipEntry` in
  `domain/project-export.ts`). macOS's `/usr/bin/unzip` reads an MS-DOS entry's
  name as code page 437 and skips any accented or emoji name, exiting 0.
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
