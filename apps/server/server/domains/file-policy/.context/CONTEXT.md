# domains/file-policy — file access decisions

Every route, tool, live room, and write seam asks this domain before touching
document state. The rules are in [file policy][file-policy] and [agent
permission][agent-permission].

## Policy

Agent refusals are `permission_denied` with reason `agent_read_only` or
`uploads_read_only` (`@meridian/contracts` `protocol/file-access.ts`; wording in
`server/lib/file-access-denial-copy.ts`). A `read` chain's system prompt says so
(`runtime/tools/agent-thread-context.ts`). The built-in Critic,
Continuity-checker and Reader-sim agents declare `permission: read`; the other
built-ins take the default `edit`.

A branch move changes the document's presented `scheme`, not its physical
`contentScheme`. File policy routes content writes from the physical scheme
until Apply moves the live identity: Scratch content stays live behind a
proposed project path, while project content stays drafted behind a proposed
Scratch path. The physical Scratch owner continues to cap delegation.

A `restore` target reads through Trash, so an undo by an old path is authorized where the
document actually returns, not at the path it was shown at. A document in no view has no
source and no facts: a restore of a discarded create is refused here, and the server's own
Undo restores it.

Facts come from the view's relations (`TreeReader.lineages`): the source and folders the view
places the document in, and `deleted` from live's Trash or the source. `survivingDraft` is a
document live has in Trash that the Work's tree still shows.

## Write seams

The write-seam order is:

1. in-process live-document critical sections;
2. Work lifecycle rows in ID order and grant confirmation;
3. advisory namespace, source, or intake locks;
4. document mutation locks in ID order.

Taking an advisory or document lock before the Work rows can deadlock archive
or purge. A new agent write entry point enters through the thread-peer pool or a
container grant.

A path that can run concurrently must not hold one pooled connection while
acquiring another. Live pulls snapshot before opening their root transaction;
remaining exceptions are tracked in [collab TODO](../../collab/.context/TODO.md).

Measure statement count and peak connection usage with the current fixtures
before narrowing confirmation, adding a cache, or changing lock ownership. A
cache must not hide Work switches or branch-view changes.

[file-policy]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/documents/access.md
[agent-permission]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/documents/access.md#agent-permission-is-separate-from-tools
