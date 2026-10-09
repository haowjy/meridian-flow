# Link correspondence

`correspondLinks` is a standalone pure ref-assignment helper exported by
`@meridian/agent-edit`. No write door calls it yet. Refs are opaque strings;
the module neither resolves targets nor knows the stored mark schema.

The input and `Binding[]` implement passes 1 and 2 of the approved
[link identity design][design]. The caller handles pass 3, classification,
resolution, minting, titles, suffixes and applying bound nodes. Normalization
is injected and cached per holder URI; each historical showing uses its own
holder URI. Pass 1 uses occurrence liveness. Pass 2 uses current `isLive`,
not the liveness when a link was shown.

## Exact assignment and order completion

1. Build the compatibility graph. Edge scores are five-component tuples:
   strong, matched, exact label, label continuity, live. Continuity counts
   common prefix and the remaining common suffix, without overlapping them
   (the r7 model's convention).
2. Split the graph into connected components. These five objectives are
   additive: independently maximizing each component lexicographically
   maximizes their global sum. A rectangular Hungarian assignment compares
   tuples directly, with no scalar weights or packing. Dummy columns allow
   unmatched links, including a strong pair beating two weak pairs. Complete
   components with interchangeable rows or columns instead select the best
   columns or rows by tuple, retaining tied alternatives and required winners.
   This avoids cubic work for duplicate links, including mixed liveness.
3. Retain the optimal assignment face, not just one assignment. Reduced-cost
   zero edges are eligible; columns with nonzero dual potential must be used.
   Complementary slackness proves both directions: every optimum uses these
   tight edges and required columns; every such completed matching attains
   the same five-component optimum. Dummy potentials are zero because there
   are as many identical dummy columns as written rows.
4. Complete the sixth objective **globally** on that face. Agreements count
   pairs `(i, j), (k, l)` where `j < l` and `i < k`. Completing order separately
   per compatibility component is incorrect: even isolated components can
   interleave. The solver searches in explicit document-key order (ascending
   old occurrence, unmatched last), compares agreements, then compares the
   sorted `(written, old)` pair key explicitly.
5. Prune with agreement upper bounds and increasing assignments within
   interchangeable old columns. Identical tight neighborhoods and required
   status make old columns interchangeable on the optimal face. Uncrossing
   two assigned interchangeable columns preserves the first five objectives
   and strictly improves agreements, including their agreements with other
   components. Therefore an optimum never crosses them. Cardinality and
   required-column bounds prune unreachable assignments. The first leaf
   attaining the global agreement upper bound is also the earliest document
   key; otherwise exhausting the search proves optimality.

The tests compare the complete bindings against independent, unpruned
exhaustive search on 1,000 generated inputs and retain an explicit example
where independent per-component order completion chooses the wrong old link.

## Bounded-search fallback

Only global document-order completion is bounded, at **50,000 candidate
visits**. If it cannot prove the optimum within that deterministic budget,
it returns the best completed assignment considered, including the initial
Hungarian assignment. The first five tuple components remain exact. The
sixth component (agreements) and the final document-key tie may differ from
unbounded exhaustive search. Pass 2 remains exact on the returned matching.
The limit is work-based, not wall-clock-based, so results are reproducible.

`correspondLinksWithDiagnostics` is the additional public entry point for
hosts that need to record fallback findings. It returns `{ bindings, exact,
orderSearchSteps }`; `exact: false` means the search budget was exhausted,
not necessarily that its answer is non-optimal. `correspondLinks` preserves
the requested `Binding[]` API and uses the same documented fallback. Hosts
should use the diagnostic form when they need observability of this limit.

Large, ambiguous optimal faces can trigger the fallback, even with relatively
few links; size alone does not control it. Unique reorders and uniform shared
addresses are certified quickly. There is no universal 50 ms guarantee for
arbitrary dense, nonuniform compatibility graphs: the exact additive phase
is cubic in a component's size. The measured 200-by-200 target workloads,
including 50 shared-address links, stay below 50 ms without fallback.

## Unspecified ties

The design does not rank different refs equally live and equally recent in
pass 2, or conflicting showings of one ref at equal observation times.
Remaining ties use ascending opaque ref, address, then holder URI. Input
array order never supplies that policy. Hosts should give genuinely newer
observations a larger `at`.

[design]: https://github.com/haowjy/meridian-flow-docs/blob/main/work/model-tool-surface/design/link-identity-729-730.md
