# file-policy TODO

## `listAccess` ignores folder ancestors

`loadList` in `adapters/drizzle-file-facts.ts` builds each row's facts with
no folder chain (`documentBase(row, documentId, [])`), while `load` walks
`folders.parent_id`. A list decision therefore never sees a deleted folder
above a document or a grant on a folder; `authorize` does. With v1 grants
(project owner only) the two agree. Before sharing adds folder grants, load
ancestors for the listed rows in the same single query (one recursive CTE
over their folder ids), and check that a folder delete still hides its
documents in `ls` and `search`.
