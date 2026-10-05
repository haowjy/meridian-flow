# domains/file-policy

The one decision about a file: whether a person or an agent may read or edit
it, and where an agent's write lands (live, or its Work's draft). Every route,
tool, live room and write seam that touches a document asks this domain.
Nothing else decides file access.

```
level = min(person term, lifecycle term, agent term)
```

- **Person:** the highest grant on the file or an ancestor (`FileGrants`
  port). v1 has one grant: the project owner gets `edit` on the project.
  Sharing replaces the adapter, not the policy.
- **Lifecycle:** deleted anywhere up the chain is `none`; a file whose
  owning Work is archived is `read`. A draft destination also takes its own
  Work's lifecycle, so an archived Work's draft is frozen. Project-owned
  files (manuscript, kb, user, unfiled) never take a Work's lifecycle.
- **Agent:** `uploads://` is `read` for every agent. Each link of the
  delegation chain (`AgentChain`, the calling thread up to the root) caps the
  result: a `read` link may edit only the scratch of its own thread's current
  Work, No Work included. The minimum over the chain wins.

`domain/policy.ts` is pure. `SOURCE_RULES` there says which sources are
drafted (`scratch://` and `uploads://` never are) and each source's agent cap.
Ancestors come from walking `folders.parent_id`; there is no closure table.

## The service (`file-access.ts`)

`createFileAccess` is the only place a `FileGrant` is minted. A grant is
proof, not a flag: it carries the principal, the facts it was decided on
(`facts.target` names what it grants) and the destination.

| Call | Use it for |
|---|---|
| `authorize(principal, target, need)` | Preflight for one target. Returns a `FileGrant` or a `FileAccessDenied`. Authoritative for reads; advisory for writes. |
| `authorizeAt(principal, target, destination)` | Edit at an explicit destination, not the one the principal's mode picks. An undo reverses a write where it landed. |
| `confirmEdit(grants)` | The authoritative re-check of edit grants, inside the write's transaction. Takes no lock: the caller has already locked the Works the grants' facts name (`grantWorkIds`) in its one id-ordered select. Reads facts once per grant, re-reads each agent chain, and re-runs the policy at each grant's own destination. A file whose owner or draft Work moved outside the locked set is refused, since locking it then would break the id order. Returns the refusals; it does not throw, so a reply can save the rest. Write seams call it through `lockSeamWorks`; the reply save locks the grants' Works itself first. |
| `listAccess(principal, documentIds)` | Lists (`ls`, `search`, recent documents, link resolution, draft review). One facts query for every row; a row the principal can't read is absent from the map, so drop it. |
| `historyAccess(principal, documentId)` | Change-trail detail. Person term only, so a deleted document's captured evidence stays visible: `"available"`, `"deleted"` or `null`. |

**Principals.** A person is `{ accountId }`. An agent adds
`{ chain, draftWork }`; `draftWork` is the Work whose draft drafted sources go
to, null outside draft mode. People always write live. Read the chain fresh
per tool call (`readAgentChain` in `runtime/loop/permissions`), never from a
turn cache: a `work switch` or rebind must show on the next call.

**Targets.** `document` for anything an agent addresses; the policy picks
live or draft. `draft` (`documentId` + `workId`) for the writer's draft
preview, Apply, Discard and branch rooms. `container` (scheme + project or
Work owner) for creates: a create needs `edit` on the container.
`lib/file-targets.ts` builds them.

**Denials.** `reason` is the wire `FileAccessDenial`: `not_found`,
`work_archived`, `agent_read_only`, `uploads_read_only`. Deleted reads as
`not_found`. A denial carries `level` (what the principal does have),
`archivedWork`, the facts when the file was found, and the agent chain so
model copy (`lib/file-access-denial-copy.ts`) can offer only calls the
action policy allows. Over HTTP, `lib/file-access-http.ts` maps `not_found`
to 404 and `work_archived` to 403.

## Adding an HTTP route

1. `requireProjectOwner` for the project, as every project route does.
2. `requireFileGrant(app.fileAccess, userId, target, need)` for each file the
   route reads or changes. A route that writes a file and creates in a folder
   needs both grants.
3. Run the write inside `withEditGrants(app.fileAccess, grants, operation)`.
   A seam's refusal under lock comes back as the same 404 or 403.

Lists go through `listAccess`. Don't stop at `requireProjectOwner`: it says
nothing about archived Works, and sharing will make it wrong.

## Write seams and lock order

`runWithEditGrants` (`edit-confirmation.ts`) binds a call's grants to its
async scope (`shared/edit-confirmation.ts`). `withEditGrants` is the HTTP
wrapper over it. The grants travel by scope, not by parameter, so
`packages/agent-edit` stays grant-free.

A write seam's transaction starts with `lockSeamWorks(db, ownWorkIds)`
(`shared/work-lifecycle-lock.ts`). It locks the seam's own Works and the
bound grants' Works in one id-ordered `FOR NO KEY UPDATE`, reading each
Work's lifecycle in that same select, then confirms the grants once per
transaction under those locks (`confirmEdit` locks nothing itself) and
returns the lifecycles. The project and No Work can't be
archived, so their files lock no Work row (`grantWorkIds`). The journal's
methods enter through `enterJournalSeam`. The order is:

1. In-process branch critical sections, when the seam has them.
2. Work rows, in id order, then grant confirmation (`lockSeamWorks`).
3. Advisory locks (namespaces, sources, intake keys).
4. Document mutation locks, in id order.

Taking an advisory or document lock before step 2 can deadlock against archive.
The seams today: the journal (seam A: `append`, `appendBatch`, the persisted
undo and redo, the live writer append), Work drafts (seam B:
`runWithActiveWorkDrafts`, draft discard, `lockDraftWorks` on turn
reversal), and context storage (seam C: `lockContextNamespaces`,
`lockContextSources`, source provisioning, upload intake).

Seams keep their own locked lifecycle check (`requireLockedActiveWorks`)
whether or not grants are bound; that check is all that guards a seam reached
with no grant scope (a replay, a derived write, a lifecycle-owned write).
Work after commit leaves the scope (`runOutsideWrite`;
`runAfterDrizzleCommit` callbacks already do), because re-confirming would
see the write's own result. Nothing pushes a draft after an agent write
(D59), so no after-commit step carries the grants.

**A reply confirms once.** The thread-peer pool's save locks the Works of
every grant the reply wrote under (`lockWorks`, one id-ordered select), calls
`confirmEdit` for those grants and drops refused documents. It binds
no grant scope; `markReplyConfirmed` instead satisfies the journal's no-grant
guard for the documents it confirmed.

**The no-grant guard sits at the journal only.** The journal knows each
write's origin, so it refuses an agent-authored write that neither a bound
grant covers nor the reply's save confirmed (`UngrantedAgentWriteError`).
Seams B and C record no origin and can't tell. An agent write that reaches
them must come through the pool or a create's container grant. A new entry
point for agent writes needs a grant; nothing downstream will catch the gap
outside the journal.

## Live rooms

Admission asks `edit` once; a denial at `read` carries the facts, and that
room is admitted read-only and
its updates never reach the journal. Each frame on an edit room runs inside
`runWithEditGrants`. Archive, unarchive, delete and restore of a Work
publish `{ workId }` through the `FileAccessChanges` port (Postgres NOTIFY,
heard after commit). `lib/yjs-room-access.ts` indexes rooms by the Works
their access depends on and closes them with 4409, so the client reconnects
at its new level. Manuscript, kb and user rooms never close on a Work change.

## Skills

`skills://` isn't a context source and has no facts or grants. `skillLevel`
(`domain/policy.ts`) is the pure rule: an agent reads a skill its own
thread's binding preloads or offers as `model-invocable`, or that the user
invoked with `/skill` in that thread (D64), and never edits one (D58). An
invocation is pinned on the thread's binding row (`invoked_skills`, slug to
the package reference the body was read from; re-invoking replaces it), so
it rides the same binding read. A spawned child, with its own binding,
doesn't inherit it; a handoff starts empty; a fork keeps it, since it copies
the turns that invoked it. A slug both bound and invoked reads from the binding's
reference. `runtime/loop/skill-files.ts` reads the binding once per call and
filters with it. Skill edits will need the same file and folder permissions.

## Performance

Measured costs per operation, what they mean for typing and agent work, and
the pool deadlock this domain's write paths once caused:
[performance.md](performance.md). Re-measure before narrowing confirmation
or adding a cache.

## Tests and in-memory

`createAllowAllFileAccess` grants and confirms everything; use it where
access isn't the subject. `test-support/file-grants.ts` has the DB helpers.
`domain/policy.test.ts` is the policy table; `file-access.db.test.ts` covers
`confirmEdit`, the guard and container coverage.
