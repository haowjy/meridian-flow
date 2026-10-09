# Link identity on the write path

A stored link, `image` or `figure` carries a `ref` (`doc:<id>` or
`ahead:<uuid>`); Markdown never does. Every door that turns written Markdown
into nodes decides which ref each written occurrence means, then applies the
assigned nodes with no Markdown round trip ([design][design]).

## Ref assignment (`src/links/assign-refs.ts`)

`assignLinkRefs` runs after parse, over the command's prepared
`HolderLinkScope`, in order:

1. Correspondence (passes 1 and 2, below) over ref-bearing old occurrences in
   the replaced span. Written pictures enter it like links (L39), so a picture
   that continues its identity is never captured by a new occupant of the path
   it was shown at. Stored and written `asset:` sources stay out: they carry no
   ref and no showing names them. Links and sources correspond separately, each under its
   own address grammar (holder-relative for links, manuscript-root for sources).
   A written link with no extension compares as its default-extension address
   (the `.md` ahead minting stores), so `[x](ch12)` written after a showing of
   `ch12.md` continues that ref after the document moved.
2. Pass 3 for the rest. A written source naming a picture the project knows
   takes the shipped image rule (`asset:<id>`, `ref: null`); everything else
   goes through markup's `assignFreshLink` (the client assigns with it too): classify (external and contextual keep `ref: null`), resolve in
   the command's view (`scope.documentFor`), else mint an ahead ref whose
   address always carries an extension.

Attribute policy, per written occurrence:

| Match | Stored attrs |
|---|---|
| pass 1, title and suffix unchanged | the old attrs verbatim: no format item is emitted |
| pass 1, title or suffix changed | old ref, written title, `storedHref(current address, written suffix)` |
| a written link equal (href and title) to a contextual old one | that old attrs object: contextual stays contextual |
| pass 2 | the shown ref, written title, `storedHref(current address or latest shown, suffix)` |
| pass 3 | `asset:<id>` for a known picture, `doc:<id>` with the document's address, a minted ahead ref, or `ref: null` |

`occurrences.ts` rebuilds only the named occurrences; every other node is
reused, so an unchanged block stays `.eq` and block alignment keeps it.

## Doors

`createWriteLinkAssigner` is the per-command ref assigner the handler builds after
`prepare` and hands the resolver's plan to assign with (`assignSpan`,
`assignSplice`). It collects the ahead refs
it mints.

| Door | Old occurrences | Notes |
|---|---|---|
| block replace (`replaceScope`) | the old scope | assigned before `alignBlocks` and no-op detection |
| insert, append | none | |
| create, create-overwrite | none / the whole document | overwrite is whole-document correspondence |
| formatted or cross-block find | inside the splice only | `restoreOutsideSplice` (below) |
| plain same-block find (`textRanges`) | none | only for blocks with no link occurrence, so a title- or ref-only change is never filtered as equal text |
| copies (`from`, `copy`) | skipped | copied nodes carry refs structurally |
| undo, redo, cold reversal, reply save | never | bytes carry recorded refs |

Handler order: load `context.shownLinks`, `links.prepare` (docs, `shown`, and
`stored` for copies), `scopeFor`, then `planWrite` (`resolver/resolve.ts`):
scope, matches, splices and every node assignment will see, a find's
reconstructed groups included, parsed with spans. The planned nodes load in a
second, incremental `prepare` (`written`), then `plan.assign` assigns and
aligns synchronously. A create parses up front and prepares once. Then
`links.registerAhead(minted)` before the write reserves an ordinal, applies,
stages or takes any lock. A registration failure fails the write before
anything is applied; the minted refs were never published. Registration may
settle a ref at once, so the handler then prepares the minted refs and their
addresses (`refs`, `addresses`) before the echo spells them.

## Find splice (`src/links/find-splice.ts`)

The formatted find path splices written Markdown into the serialized group
and the plan reparses it with spans. `spliceFindMatches` (`resolver/find.ts`) returns the
pre-splice text and one union splice over every match. Occurrences whose
source span ends before the splice, or starts after it, keep their old
twin's attrs verbatim; only inside occurrences are assigned. When the
surrounding syntax reparses differently, or ingress rewrote the text so every
span is the whole text, the whole group is assigned instead and
`onLinkSpliceFallback` reports it: identity still follows correspondence, but
unchanged links in that group may churn their formatting.

## Shown-link facts (`src/links/shown.ts`)

Host-only evidence of what the model saw: `{ ref, address }` per ref-bearing
occurrence actually rendered. The command's scoped codec keeps a ledger of every
link-bearing hashline it renders (the hash and body it emitted, and each
ref-bearing occurrence's address spelled in that scope), and `codec.shownLinks(items)`
reads a result's items back by the hash they carry, never the document's
current state. A whole item counts all its links; a prefix counts only links
whose `parseWithSpans` span ends inside it. Equal text rendered from
different states counts only what every such render showed, and a render
whose links carry no ref is kept as one, so it clears an earlier ref; an item this
codec never rendered, or a reparse that disagrees, counts nothing. They ride
as one `showing: { holderUri, view, links }` (`LinkShowing`): the facts with
the holder URI and view the command's links spelled them from
(`shownEvidence` in `links/shown.ts`), on `WriteOutcome.showing` (reads,
echoes, undo and redo), `ResponseCommitWriteReceipt.showing`, and each
`ConcurrentEditRun.showing` (per run, because the request budget may drop
runs). None of them reaches `result`. `WriteContext.shownLinks(documentId)`
delivers the thread's stored showings back to assignment; agent-edit never
reads thread history.

## Correspondence (`src/links/correspondence.ts`)

The pure helper for passes 1 and 2. Refs are opaque strings; correspondence
neither resolves targets nor knows the stored mark schema.

Written hrefs normalize against each showing's recorded holder URI and the
current holder as appropriate. Pass 1 uses occurrence liveness; pass 2 uses
current `isLive` and each ref's latest showing only, never historical-only
addresses. Equally live and recent showings use opaque ref, address and
holder-URI ordering rather than input enumeration. Label continuity counts a
common prefix and remaining common suffix without overlap.

## Exact ranking

Compatible pairs have six-component tuple scores: strong, matched, exact
label, continuity, live and negative normalized-position displacement. The
last score is `−|j·(oldCount−1) − i·(writtenCount−1)|`, using the original
span-wide indices, not component-local indices. Components are independent
because all six objectives are additive. Rectangular Hungarian assignment
compares vectors lexicographically, never packed weights; dummy columns
permit unmatched links when strong precedence sacrifices compatible pairs.
Complete graphs always extend a maximum-strong matching to maximum
cardinality, so they need only the unavoidable dummies. Square assignments
start with column-minimum potentials; rectangular ones start at zero.
Reduced-cost checks use actual dummy potentials in both cases.

Zero reduced-cost edges and required nonzero-dual columns describe the whole
optimal face by complementary slackness. The final explicit document-key tie
walks written rows in order, choosing the earliest tight old column that
admits an optimal completion. Alternating paths retain earlier choices and
keep every required column covered; a synthetic dummy row permits exchange
of free optional columns. Unmatched dummies come after every old occurrence.
This is exact and polynomial: there is no search budget, fallback or diagnostic
API. Generated exhaustive-oracle tests vary counts, labels, liveness,
showing history and relative-URL normalization across holder URIs.

[design]: https://github.com/haowjy/meridian-flow-docs/blob/main/work/model-tool-surface/design/link-identity-729-730.md
