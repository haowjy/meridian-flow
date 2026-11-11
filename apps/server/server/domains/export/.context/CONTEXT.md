# domains/export — mechanism

Entry rules: [AGENTS.md](../AGENTS.md).

## Download

One session-authenticated GET `/api/projects/:id/export.zip` with
`scratch=0|1&uploads=0|1`. Every request rechecks document and Work file policy,
freezes the paths, and streams. There is no ticket, prepared state or process
lifetime dependency. The marker's counts (`formatVersion`, `areas`, `works`, and
the count of internal link occurrences excluded) come from the streamed
serialization pass.

ZIP output is incremental, with browser and network backpressure, so a 200 MiB
file costs a chunk, not its size. A stored file is opened before its zip entry is
added. One the store reports `not_found` is left out and named in
`Missing files.txt` at the zip's root; any other failure cuts the connection.
fflate has no ZIP64, so `download` refuses (413, plain message) when the stored
sizes in the snapshot add up to near 4 GiB, rather than send a corrupt zip.

## Preview

GET `/api/projects/:id/export/preview` returns advisory current-state outside-link
and unapplied-draft counts. It runs the same `ExportLinkScope` pass the ZIP uses
over current collab content rather than `document_links`: those rows are a lagging
certified-cut hint, omit ref-less internal hrefs, and would need a second
outside-link classifier (settlements, ahead paths, contextual hrefs) that could
drift from the export. The request's abort signal stops the pass between
documents, so a superseded or closed-dialog preview stops reading. Preview and
download can differ when content changes. The browser owns download progress and
failure; preview errors belong in the dialog and do not prevent Export.
