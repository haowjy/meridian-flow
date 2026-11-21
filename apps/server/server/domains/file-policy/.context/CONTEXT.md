# domains/file-policy — file access decisions

Every route, tool, live room, and write seam asks this domain before touching
document state. The rules are in [file policy][file-policy] and [agent
permission][agent-permission].

## Policy

Agent refusals are `permission_denied` with reason `agent_read_only`, `uploads_read_only`
or `ai_access_denied` (`@meridian/contracts` `protocol/file-access.ts`; wording in
`server/lib/file-access-denial-copy.ts`). A `read` chain's system prompt says so
(`runtime/tools/agent-thread-context.ts`). The built-in Critic,
Continuity-checker and Reader-sim agents declare `permission: read`; the other
built-ins take the default `edit`.

A deleted Work's files read until its purge, and a write to one is limited by `work_deleted`. The
term order hides existence: a person who can't read the file meets the person term first, so they
get `not_found`. Transports read `reason` and nothing else: HTTP answers 404 `work_deleted`, draft
review names it, and to the model the file reads as gone (`isPermissionDenial` leaves it out, and a
text edit is returned with `work_deleted`).

## AI access

`placeAccess(facts)` is what a place does with an AI write: `auto-apply`, `ask` or `deny`. It takes
the nearest stored setting on the file's *live* folder chain (`FileFacts.aiAccessSettings`, nearest
first, never from a draft's view, or a draft move of a file out of a `deny` folder escapes it), then
the source's fixed rule (`FIXED_AI_ACCESS`, empty), then `auto-apply`. `ask` on a source that can't
hold a draft (`isDrafted`) reads as `deny`, since landing it live would skip the review it asks for.

- **Destination.** `Principal.agent` always has `draftOwner` and `writeMode`. A write goes to a draft
  when the chat's mode is draft or the place asks, and the source is drafted; otherwise live.
  `destinationFor` decides it per document from facts; `sourceDestination` decides it per source for
  creates and tree views, from the fixed rule alone. Everything that has a document (revisions,
  reads, lists) reads the destination from its decision or grant, never from the chat's mode. A stored per-folder setting needs creates to ask per path, and `placementFor`
  (context) must change before then.
- **Facts follow the destination.** An auto-apply chat loads live facts. Only a place whose
  destination is a draft loads the draft's view, `draftOwner` lifecycle and locks (`loadFor`,
  `loadListFor` in `file-access.ts`), and a document only the draft holds is found there. Once live facts say draft, the draft's
  facts are the answer, null included: a document the draft dropped is `not_found`. Draft mode
  loads the draft's view for every document, as before.
- **Deny.** A `deny` place caps an agent at `read` with `ai_access_denied`, a `permission_denied`
  refusal that no retry or re-read helps. A person never meets it.
- **Agents levels (`agents://`, `user://.agents/`)** are ordinary places: no term in the policy
  names them. With no stored setting an AI's edit to an Agent or skill file lands live, and is
  used by no chat until a Save; a writer who wants review sets the folder to `ask` through the
  general setting. Undo is the normal receipt Undo.
- **Not built yet.** Stored settings (written only by the writer's tree command, never a model tool);
  a rule for another Work's Scratch; a setting that changes
  between authorize and confirm (`confirmEdit` re-checks the level at the grant's destination, not the
  destination: that waits for the executor's rerun of a failed effect).

**A moved owner restarts the write; it never refuses.** The seam passes `confirmEdit` what it locked.
A document whose owner (or draft owner) is outside that set, because it moved after the grants were
minted, throws `TreeOwnersMoved` naming the owners. The restart belongs to whoever owns the transaction
(`untilOwnersHold`, the one restart rule): `runCommand` wraps its whole transaction in it, so the
attempt rolls back, releasing every lock it took, before the next one starts with the learned owners
in its first lock set; no restart waits on a lock while holding another. A command has one loop: a
call made inside it (`runWithEditGrants`, an operation's `withTreeOwners`), or inside a transaction
nobody there owns, runs once and lets `TreeOwnersMoved` reach the owner, so a committed command never
runs again. `runWithEditGrants` restarts only when it has no transaction around it (a write whose
seam opens its own). Each restart adds an owner and a project has finitely many, so it ends.
A missing document or a denied level still answers `not_found` or the denial.

A draft move changes the document's presented `scheme`, not its physical
`contentScheme`. File policy routes content writes from the physical scheme
until Apply moves the live identity: Scratch content stays live behind a
proposed project path, while project content stays drafted behind a proposed
Scratch path. The physical Scratch owner continues to cap delegation.

The decision also carries `command`: whether the person may run a document command (Apply,
Un-Apply, Discard, Undo of a Discard) there, or Copy into or out of a closed Work (a Copy's
destination asks `command`; a source in Trash asks it too, since a deleted file's `read` is none). It is `edit` by grants and agent terms and ignores the
lifecycle terms, so a closed Work, a chat in Trash or a deleted document passes: the command itself
answers a closed owner (`returned`, under the Work lock) instead of the route refusing it. `level` is
unchanged, so words stay read-only.

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
or purge. A new agent write entry point enters through `modelEdits().write` or a
container grant.

A path that can run concurrently must not hold one pooled connection while
acquiring another. Live pulls snapshot before opening their root transaction;
remaining exceptions are tracked in [collab TODO](../../collab/.context/TODO.md).

Measure statement count and peak connection usage with the current fixtures
before narrowing confirmation, adding a cache, or changing lock ownership. A
cache must not hide Work switches or draft-view changes.

[file-policy]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/documents/access.md
[agent-permission]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/documents/access.md#agent-permission-is-separate-from-tools
