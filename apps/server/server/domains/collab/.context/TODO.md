# collab TODO

## Reactivated accept re-applies moves as safe-degrade (cannot_place)

Reactivated (gen>=1, post-undo) accept now fails closed to `cannot_place` on any touched block that is not provably matched by durable id or unique content; moves are not auto-re-placed after undo.

Why: four regressions came from trying to infer moved-block placement from content after undo creates fresh ids, so the safe floor deliberately prioritizes the correctness invariant that writer content is never lost or duplicated over auto-re-apply convenience.

To revisit: feature-track how often writers hit reactivation accept and how often it returns `cannot_place` vs `applied`; only if data shows it matters, rebuild provable moved-block re-placement via durable block identity that survives undo, not smarter content heuristics; see research notes in `work/human-undo-affordance/`.
