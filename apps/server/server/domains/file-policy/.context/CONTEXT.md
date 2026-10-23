# domains/file-policy — file access decisions

This domain is the only authority for whether a person or agent may read or
edit a file and where an agent write lands. Every route, tool, live room, and
write seam asks it before touching document state.

## Policy

The effective level is the minimum of person, lifecycle, and agent terms:

```text
level = min(person term, lifecycle term, agent term)
```

- **Person** is the strongest grant on the file or an ancestor. The current
  adapter grants the project owner `edit`; sharing belongs in the adapter, not
  in policy.
- **Lifecycle** makes deleted ancestry `none` and an archived Work's files
  `read`. A draft destination also takes its Work lifecycle. One exception
  (D79): `survivingDraft` lifts the document's own or folder's delete at a
  draft destination whose branch has an active Work draft of it
  (`survivingDraftDocuments` in `context/tree/living-document.ts`, the same
  proof draft creation uses under its lock). It is keyed on the destination,
  never on the view that supplied the facts, and never reads `has_effect`, so a
  writer's review list (branch views, live destination) stays denied and a
  no-effect draft stays writable. Source, project and Work deletions stay `none`. Project-owned
  Manuscript, KB, User, and Unfiled files do not inherit a Work lifecycle.
- **Agent** allows uploads to be read. Each delegation link caps the result;
  Scratch ownership is the named Work or the No Work chat lineage selected by
  `scratchOwnerFor`. A `read` link may edit only its own Scratch owner; an
  `edit` chain may write another lineage by its canonical URI. The minimum
  across the chain wins.

Agent refusals are `permission_denied` with reason `agent_read_only` or
`uploads_read_only` (`@meridian/contracts` `protocol/file-access.ts`; wording in
`server/lib/file-access-denial-copy.ts`). A `read` chain's system prompt says so
(`runtime/tools/agent-thread-context.ts`). The built-in Critic,
Continuity-checker and Reader-sim agents declare `permission: read`; the other
built-ins take the default `edit`.

`domain/policy.ts` is pure. `SOURCE_RULES` decides whether a source is drafted
(Scratch and Uploads are never drafted) and the agent cap. File facts use the
canonical branch resolver and the selected tree view; hidden identities outside
that view have no facts unless they are discarded tombstones. Those retain
deleted facts for person-authorized removal history, never readable content.
Neither does a Work's draft of a document it may
not hold (`branchMayHold`: its project's, or its account's `user://`).

A branch move changes the document's presented `scheme`, not its physical
`contentScheme`. File policy routes content writes from the physical scheme
until Apply moves the live identity: Scratch content stays live behind a
proposed project path, while project content stays drafted behind a proposed
Scratch path. The physical Scratch owner continues to cap delegation.

## Grants and service boundary

`createFileAccess` is the only grant mint. A `FileGrant` carries principal,
decided facts, and destination; it is proof of one authorization decision, not
a boolean flag. `authorize` preflights one target. `authorizeAt` checks an
explicit destination for draft preview, Apply, Discard, or reversal. `listAccess`
batches readable identities for listing, search, links, and review; a row the
principal cannot read is absent from the result, so callers drop it. `historyAccess`
exposes person-scoped change evidence for deleted files.

`confirmEdit` is the authoritative write recheck. The caller locks every Work
named by the grants in one ID-ordered select before calling it; the function
re-reads facts and agent chains without taking another lock, returns refusals,
and lets a reply save the rest. Read agent-chain state fresh on every tool call;
a Work switch or rebind must affect the next call.

Targets are explicit: `document` for ordinary file access, `draft` for a
Work-branch view, `container` for creates, and `restore` for an identity an
inverse brings back. A live restore reads the document's own folder and source
without its own delete (a deleted folder or source above it still hides it), so
an undo by an old path is authorized where the document actually returns, not
at the path it was shown at. A restore checked at a draft destination may read
the hidden physical identity after that branch's create was undone while
another branch kept it alive; the destination Work still supplies its lifecycle
and lock. A create in a folder needs both the container grant and the document
grant it will write. Denials preserve a wire reason and the facts needed for
allowed recovery; deleted reads are `not_found` (HTTP 404) and archived Work
writes are `work_archived` (HTTP 403). People always write live; only an agent
principal carries a branch Work.

## Route and seam rules

An HTTP route authenticates project ownership, obtains every required grant,
and runs writes through `withEditGrants`. Lists use `listAccess`; ownership
alone says nothing about archived Work files. The grant scope travels through
async context so agent-edit remains grant-free.

The write-seam order is:

1. in-process live-document critical sections;
2. Work lifecycle rows in ID order and grant confirmation;
3. advisory namespace, source, or intake locks;
4. document mutation locks in ID order.

Taking an advisory or document lock before the Work rows can deadlock archive
or purge. Each seam repeats its own active-Work check because replay,
derivation, and lifecycle-owned writes may have no grant scope. The journal
alone enforces the no-grant guard for agent-authored rows; a new agent write
entry point must enter through the thread-peer pool or a container grant.

A reply save locks the Works of all grants it used, confirms those grants once,
and marks confirmed documents for the journal guard without leaving a grant
scope after commit. Draft pushes do not happen as an after-commit grant step.

## Live rooms and skills

Room admission asks for `edit` once. A read-only admission never journals
updates. Each editable frame runs in the grant scope. Work lifecycle changes
publish access changes after commit; dependent rooms close with 4409 and
reconnect. Manuscript, KB, and User rooms do not close for a Work change.

`skills://` is not a context source and has no file grants. `skillLevel` reads
the thread binding once per call and permits only bound, model-invocable, or
user-invoked skills. Skills are never edited through this policy.

See [performance guidance](performance.md) before changing batching, grant
confirmation, or connection ownership, and use the domain tests for policy and
DB-grant coverage.
