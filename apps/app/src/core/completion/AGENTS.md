# core/completion — headless suggestion and reference policy

This directory owns the generation-fenced menu store and the hierarchical
reference browser over the normalized catalog. Hosts provide trigger envelopes,
geometry, insertion, and rendering; this package imports none of those UI
concerns.

## Mental model

- A driver owns one menu session and generation. Accepted open, update, and
  close transitions install their snapshot, run the lifecycle callback, then
  notify subscribers in FIFO order. Stale tickets and reentrant transitions
  cannot publish after a newer session.
- `SuggestionHost` leases ordinary navigation and semantic retreat. The menu
  owns selection movement and Enter/Tab intent; hosts decide Escape precedence,
  insertion, and dismissal. A withdrawn catalog closes through `close()`.
- `anchorRect` is host-supplied geometry. No ProseMirror, DOM, React, or
  writer-facing copy crosses this boundary.
- `ReferenceCatalogPort` projects the single catalog cache. It does not build a
  tree, enumerate availability, or treat wake hints as rows. Cold Work
  acquisition remains an explicit owner operation; known-empty sources are
  omitted except for explicit source/folder searches, which retain an empty
  state until Back.
- Ranking uses strict exact, prefix, word-start, contains, and fuzzy tiers;
  contextual priors only break ties within a tier. Stable document identity is
  deduplicated before the final 20-row cap.
- Terminal rows already contain an `AuthoritativeReference`, a union on
  `kind`: a document (validated URI, identity, classification, authority) or a
  folder (identity and URI). Contextual Work syntax is never reconstructed into
  stable identity here. Rows expose location so equal names remain
  distinguishable.
- Where the host's `kinds` admit folders, a folder's listing (no search) leads
  with one `folder-mention` row, so a folder is mentioned from inside it and a
  folder row itself always drills. Area roots are not mentionable. Empty
  folders stay reachable only where folders are mentionable; file-only hosts
  keep file-only reachability.
- An Editor host may append one `LinkAheadRow` for a root query with no exact
  catalog match. It computes and writes the address; the browser does not create
  a document. Chat references are identity-bearing and never link ahead.

## Key rules

- Keep this package independent of `editor/`, `features/`, and rendering
  libraries. Surface-specific state belongs in the host.
- Read callbacks live: `start`, `update`, `exit`, row choice, dismissal,
  segment completion, terminal selection, and `anchorRect` are not copied into
  a second controller.
- Enter drills or selects; Tab selects a terminal and completes one URI segment
  on navigation rows. Retreat backtracks before root dismissal.
- Bare `@` is a trigger, never a reference-create row. No placeholder row may
  become a terminal reference.
- One title-matching rule. A second ranking implementation makes two menus
  disagree about one query, and one of them disagrees with the resolver.
- Anything only one surface renders goes in `TMeta` or the host's own state,
  never the shared snapshot.

→ [`../editor/extensions/at-reference/`](../editor/extensions/at-reference/AGENTS.md)
  — Editor reference insertion and link-ahead adapter
→ [`.context/CONTEXT.md`](.context/CONTEXT.md) — callback and cold-source details
