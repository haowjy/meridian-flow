# Link identity on the write path

A stored link, `image` or `figure` carries a `ref` (`doc:<id>` or
`ahead:<uuid>`); Markdown never does. Every door that turns written Markdown
into nodes decides which ref each written occurrence means, then applies the
bound nodes with no Markdown round trip ([design][design]).

## Ref assignment (`src/links/assign-refs.ts`)

`assignLinkRefs` runs after parse, over the command's prepared
`HolderLinkScope`, in order:

1. The shipped `asset:` image rule (`bindSources`); `asset:` sources leave the run.
2. Correspondence (passes 1 and 2, below) over ref-bearing old occurrences in
   the replaced span. Links and sources correspond separately, each under its
   own address grammar (holder-relative for links, manuscript-root for sources).
3. Pass 3 for the rest: classify (external and contextual keep `ref: null`),
   resolve in the command's view (`scope.documentFor`), else mint an ahead ref
   whose address always carries an extension.

Attribute policy, per written occurrence:

| Binding | Stored attrs |
|---|---|
| pass 1, title and suffix unchanged | the old attrs verbatim: no format item is emitted |
| pass 1, title or suffix changed | old ref, written title, `storedHref(current address, written suffix)` |
| a written link equal (href and title) to a contextual old one | that old attrs object: contextual stays contextual |
| pass 2 | the shown ref, written title, `storedHref(current address or latest shown, suffix)` |
| pass 3 | `doc:<id>` with the document's address, or a minted ahead ref, or `ref: null` |

`occurrences.ts` rebuilds only the named occurrences; every other node is
reused, so an unchanged block stays `.eq` and block alignment keeps it.

## Doors

`createWriteLinkAssigner` is the per-command binder the handler builds after
`prepare` and hands the resolver as `ResolveWriteContext.links`. It collects
the ahead refs it mints.

| Door | Old occurrences | Notes |
|---|---|---|
| block replace (`replaceScope`) | the old scope | bound before `alignBlocks` and no-op detection |
| insert, append | none | |
| create, create-overwrite | none / the whole document | overwrite is whole-document correspondence |
| formatted or cross-block find | inside the splice only | `restoreOutsideSplice` (below) |
| plain same-block find (`textRanges`) | none | only for blocks with no link occurrence, so a title- or ref-only change is never filtered as equal text |
| copies (`from`, `copy`) | skipped | copied nodes carry refs structurally |
| undo, redo, cold reversal, reply save | never | bytes carry recorded refs |

Handler order: parse, load `context.shownLinks`, `links.prepare` (with
`written` and `shown`), `scopeFor`, synchronous resolve with binding, then
`links.registerAhead(minted)` before the write reserves an ordinal, applies,
stages or takes any lock. A registration failure fails the write before
anything is applied; the minted refs were never published.

## Find splice (`src/links/find-splice.ts`)

The formatted find path splices written Markdown into the serialized group
and reparses it. `spliceFindMatches` (`resolver/find.ts`) returns the
pre-splice text and one union splice over every match. Occurrences whose
source span ends before the splice, or starts after it, keep their old
twin's attrs verbatim; only inside occurrences are assigned. When the
surrounding syntax reparses differently, or ingress rewrote the text so every
span is the whole text, the whole group is bound instead and
`onLinkSpliceFallback` reports it: identity still follows correspondence, but
unchanged links in that group may churn their formatting.

## Shown-link facts (`src/links/shown.ts`)

Host-only evidence of what the model saw: `{ ref, address }` per ref-bearing
occurrence actually rendered, spelled with the command's scope in the same
synchronous block. Facts are computed from the rendered `hash|body` items,
matched to blocks by hash: a whole block counts all its links, a prefix
counts only links whose `parseWithSpans` span ends inside it, and anything
else (another state's render, a swept deletion, a reparse that disagrees)
counts nothing. They ride on `WriteOutcome.shownLinks` (reads, echoes, undo
and redo), `ResponseCommitWriteReceipt.shownLinks`, and each
`ConcurrentEditRun.shownLinks` (per run, because the request budget may drop
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
