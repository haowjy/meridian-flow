# Completion contracts

This page records the non-visual completion contracts that are easy to miss in
the source. The store is a projection and lifecycle owner, not a catalog or
insertion authority.

## Browser projection

Root rows merge project, user, current Work or No Work, and No Work lineage
Scratch from the warm catalog view. Other Works remain authority rows until
explicitly activated. A folder or source is not proof of contents while its
metadata is cold; only an acquired, known-empty authority is omitted. An
explicit URI query may show an empty source/folder state.

The browser delegates cold Work acquisition to the catalog owner. It must not
fetch recursively, retain catalog entries, or convert availability requests or
wake notifications into browse rows. URI segments are completed by the host's
canonical callback, not reconstructed from display labels.

## Menu lifecycle

The driver ticket is `(sessionId, generation)`; close consumes the complete
ticket. A host may keep an empty session while loading or displaying an empty
state, but selectable rows are required before ordinary open. Refreshes reset
selection only when the caller requests it; a same-session refresh may preserve
the stable active row ID. A host refusal is skipped rather than highlighted.

The host lease is released exactly once and removes both ordinary key bindings
and retreat. Navigation rows drill after completing one canonical segment;
terminal rows select or link according to the host's callback.
