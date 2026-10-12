# Project export

Export reads live documents, not Work drafts. A request captures the inventory,
canonical addresses and ahead settlements before reading any content. Layout
and link spelling use that captured identity map for the entire ZIP, even if
files move while it streams.

- `ports/` owns the inventory boundary; the Drizzle adapter takes a short
  repeatable-read snapshot, not a transaction spanning a download.
- The service filters through file policy and live manifest membership.
  Archived Work files remain readable and are included when selected.
- ZIP output is incremental, with browser/network backpressure. Object storage
  currently supplies one binary's bytes at a time; never gather project bytes.
- Ordinary/model serialization must never use the export codec. The explicit
  collab export read door receives an export scope over the frozen map.
- The visible `meridian-export.json` marker carries `formatVersion`, `areas`,
  `works`, and the count of internal link occurrences excluded from the vault.

Project export is one session-authenticated GET `/api/projects/:id/export.zip`
with `scratch=0|1&uploads=0|1`. Every request rechecks document/Work file policy,
freezes the paths, and streams. There is no ticket, prepared state or process
lifetime dependency. Marker counts come from the streamed serialization pass.
GET `/api/projects/:id/export/preview` returns advisory current-state outside-link
and unapplied-draft counts. It runs the same `ExportLinkScope` pass the ZIP
uses over current collab content rather than `document_links`: those rows are a
lagging certified-cut hint, omit ref-less internal hrefs, and would need a second
outside-link classifier (settlements, ahead paths, contextual hrefs) that could
drift from the export. Preview and download can differ when content changes. Browser owns download progress/failure; preview errors
belong in the dialog and do not prevent Export.
