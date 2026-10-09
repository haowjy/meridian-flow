# Link correspondence

`src/links/correspondence.ts` is the in-package pure helper for passes 1 and 2
of [link ref assignment][design]. The binder owns pass 3, classification,
resolution, minting and attributes. Refs are opaque strings; correspondence
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
