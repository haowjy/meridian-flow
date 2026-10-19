# context/tree — views, identity, and hidden-node lifecycle

This page records how live and branch tree views expose identity and how hidden
nodes move through create, reveal, end-of-use, and repair. The one hidden
predicate and the lock order are the load-bearing rules.

## Views and ownership

`TreeView` is `LIVE_TREE` or `{ kind: "branch", branchId }`. Live views exclude
deleted and hidden rows. A branch view includes its live rows plus the hidden
documents and folders it created or needs as ancestors, at their row-owned
location. A path with two visible nodes answers `ambiguous`; normalization is a
write operation, while `treeState` reports the clash.

`branch-ownership.ts` is the single rule for which branches may hold a document:
the branch's project, or the account owner's personal `user://` source. End of
use, Discard, purge, repair, and reveal count every active branch that may hold
the row, so one hidden `user://` document can be shared by branches in several
projects of one account, never another account's. Never replace this rule with
a project-only check.

`identityStatus(view, ids)` distinguishes visible, branch-hidden, gone,
deleted, and malformed/unspellable identities. A hidden row with no active use
is gone and may be repaired asynchronously. Link presence and file facts use
this status; hidden rows outside the selected view are absent.

Anything deciding whether a node may stand at a path asks as a kind (document
or folder) through one rule, so a create, placement, move, Apply hold, and
`treeState` clash diagnostic agree and review and Apply cannot disagree. A
folder holds its document alias (`Lore.md` holds `Lore`); folders never clash
with folders through it. Browsing never asks as a kind, and a path two nodes
share answers a clash, never a pick.

## Lifecycle rules

A draft-created document is a real row with empty live content; its text lives
in its draft until Apply. Live create may reveal a hidden candidate instead
of inserting a twin. `document_forwards` preserves a client-minted ID when a
create joins an existing draft document. Placement reveals targets and
ancestors; end-of-use tombstones an unused row, releases its Yjs/draft/derived
storage, and prunes empty hidden ancestors.

`acquireEndUseScope` takes the complete namespace/document scope and rechecks
that scope before mutation. A moved scope aborts and rediscovers. Hidden-node
repair uses the same seam in its own transaction and reports after commit.
Tree writes return changed identities; ContextFS, the mover, Apply, and Discard
refresh the catalog in their own surrounding transaction.

## Removal facts

`DocumentRemovals` is the context-owned port for current tombstone records;
`tree/document-removals.ts` joins actor names in the caller's transaction.
Callers must authorize identity access before exposing its result (availability
does so through its existing classification). `DocumentRemovedError` lives
with the port, so collab need not import a context adapter. A writer's Discard
never sets the Work-cascade restore marker. Retractions name
`reply_rolled_back` or `create_failed`; both repair paths name `repair`.

## Lock and identity contracts

Before the first document lock, callers take in-process leases, thread/Work and
branch rows, sorted namespace keys, then document locks and row locks. Work/branch
lifecycle locks use the FK-compatible mode required by the caller. Never take a
namespace lock while holding a document lock.

Location claims and history use location-only CAS tokens. A move snapshots the
subtree, checks the final path, handles hidden splits/absorbs, and then records
history and versions. Apply reveals through placement and never restores a
removed document (W52); it does not move nodes. Tree code never refreshes the catalog independently of its caller.
