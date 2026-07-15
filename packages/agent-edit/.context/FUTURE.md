# FUTURE — deferred directions (not commitments)

## Teach the model about mangled merges (deferred 2026-07-14)

Ruled during the amendment-4 (sync-receipt) design session: the echo's
concurrent-merge marker stays a plain **"concurrent edits"** label — no
repair invitation, no extra instruction.

Context: when a writer and the agent edit the same block concurrently, the
Yjs character-level merge keeps every word but can interleave them oddly
("mangled-but-intact", per the reconcile-semantics KB decision — the system
itself never resolves conflicts). Under sync-receipt semantics the echo
renders the merged block to the model, so a model-initiated repair would be
an informed edit and safe by construction.

Deferred idea: extend the echo copy to tell the model it MAY repair a
mangled merged sentence (e.g. "merged with human edit — repair if the
result reads mangled"). Revisit only if real transcripts show models
leaving mangled merges unfixed, or over-fixing prose the writer wanted
left alone. Needs prompt-side validation against live models before
shipping; the human explicitly chose to say nothing for now.

Owner seam: `src/apply/echo.ts` marker rendering +
`src/tool/response-format.ts` concurrent section copy.
