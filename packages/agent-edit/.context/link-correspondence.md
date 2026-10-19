# Link identity on the write path

Stored links, images, and figures carry `doc:<id>` or `ahead:<uuid>` refs;
Markdown does not. Every Markdown-to-node door assigns refs in a prepared
holder scope, then applies assigned nodes without a Markdown round trip.

## Assignment

`assignLinkRefs` runs after parse and in three conceptual passes:

Scoped written hrefs expand before all three passes. Stored occurrences and shown
evidence remain canonical-only; neither is expanded at assignment.

1. Continue identity-bearing old occurrences in the replaced span, including
   `asset:<id>` pictures, while keeping links and sources in their own address
   grammars.
2. Continue an identity shown to the model at the occurrence it wrote over.
3. For the remainder, preserve external/contextual links, assign known images
   as assets, resolve in the command view, or mint an ahead ref with its
   canonical address.

An unchanged occurrence keeps its old attributes verbatim. A changed title or
suffix keeps identity while updating written metadata. A copied node keeps its
stored ref structurally; copies are never reassigned. Ahead refs are registered
before mutation, and a registration failure fails the write before anything is
applied, since the minted refs were never made visible. The command prepares the
minted refs again before echo serialization.

## Serialization doors

The handler loads shown facts, prepares the host scope, plans the write, prepares
planned nodes, assigns refs, aligns, and only then applies. Doors use the
following scope:

- block replacement uses the old scope;
- insert/append has no old occurrence;
- create-overwrite uses whole-document correspondence;
- formatted or cross-block find uses the affected splice;
- plain same-block find uses exact text ranges and only blocks without link
  occurrences;
- copies, inverse edits, and reply-save bytes already carry refs.

A formatted splice preserves occurrences outside the written span. If reparsing
changes surrounding syntax so spans cannot be trusted, assign the whole group
and emit a fallback diagnostic; identity remains safe even when formatting
churns.

## Shown facts and correspondence

Shown facts record `{ ref, address }` for identity-bearing occurrences actually
rendered by the scoped codec, together with holder URI and view. The result
ledger is keyed by rendered hash and item span, not by a later document read.
Unrendered items or mismatched reparses contribute no fact. Empty image
addresses are explicit evidence and may continue a picture written back over
the same empty source.

The pure correspondence helper resolves relative hrefs against the recorded
holder and current holder, considers liveness and latest showing, and chooses
one-to-one matches by opaque identity, address, label continuity, and stable
position tie-breaks. It never resolves targets or depends on markup internals.
Ambiguous correspondence must not credit writer content to the agent.

The host's `DocumentLinksPort` prepares rows by ID, settlement, and address in
batches. A scope miss is a diagnostic/typed snapshot miss, not a guessed path.
See [write architecture](write-architecture.md) and the
[link-identity design][design].

[design]: https://github.com/haowjy/meridian-flow-docs/blob/main/work/model-tool-surface/design/link-identity-729-730.md
