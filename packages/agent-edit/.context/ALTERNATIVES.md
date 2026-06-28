# Alternatives considered — agent-edit

Design directions we evaluated and **chose not to take**, with the reasoning, so
we don't silently re-litigate them. These are not deferred work (see `TODO.md`
for that) — they are roads we looked down and walked away from. Each entry says
what it is, why it's tempting, why we declined, and what would make us revisit.

---

## Pure offline-peer with a separable pending-ops overlay (no discard-and-rebuild)

**Status:** declined for now. Not planned — we may never do this, and it carries
real breakage risk.

### What it is

Today the runtime Y.Doc is reconciled by **cold reconstruction**: read, rollback,
and recovery all *discard* the runtime replica and rebuild it from canonical
(live ⊕ journal), then replay any pending staged updates. There is deliberately
no durable hot state — no runtime redo stack, no rehydration cache, no hot
`UndoManager` (deleted in commit `663878cf`).

The alternative models the runtime as a strict offline peer with two persisted
layers:

- a **clean synced base** (canonical as of the last sync), and
- a **separable pending-ops overlay** (this response's staged ops as a distinct,
  inspectable layer).

The runtime is always `base ⊕ overlay`. Then:

- response **rollback** = drop the overlay (no rebuild),
- response **commit** = fold the overlay into the base + journal,
- **recovery** = replay journal into the base; the overlay is independent.

The appeal: it deletes the discard-and-rebuild path entirely (the "Source B"
question from the human-undo-affordance work) and makes rollback O(overlay)
instead of a full reconstruction.

### Why we declined

1. **It walks back the load-bearing decision.** The whole sync engine is built on
   *"canonical is authoritative; hot state is disposable"* (see `CONTEXT.md` →
   "Sync engine"). Cold reconstruction is *why* a `read` "can never carry runtime
   drift forward or corrupt the doc." A durable overlay reintroduces exactly the
   hot, persisted, must-stay-consistent state that decision exists to eliminate.
2. **It adds a new consistency surface.** The overlay must be persisted, versioned,
   and kept reconcilable with the journal across crashes, concurrent human edits,
   and partial commits — the failure modes cold reconstruction collapses into one
   well-tested rebuild path.
3. **High blast radius for unproven benefit.** It would touch staging, commit,
   echo computation, and the concurrent-edit attribution that currently leans on
   rebuild-from-canonical (`CONTEXT.md`: "Commit re-sync is a delta+origin apply"
   — `read`'s rebuild can't attribute, so the two paths exist for a reason). It is
   plausible this breaks invariants we currently get for free, for a cost
   (cold-rebuild per turn) that has **not** shown up as a real problem.

### What would make us revisit

Only if cold-rebuild cost becomes a *measured* bottleneck (e.g. very large docs
where per-turn reconstruction dominates latency). Until then the simplicity of a
single authoritative rebuild path wins.

### Related

- The narrower, already-shipped fix: PR #98 made recovery automatic and invisible
  to the model (auto cold-rebuild in `requireSynced`) — keeping cold
  reconstruction as the mechanism while removing its leak into the model's
  contract. That captured the *user-facing* win without taking on the overlay.
- The `staleLiveDocs` flag (`runtime-store.ts`) tracks only "the shared live doc
  needs journal replay" — it is not a hot cache and not part of this alternative.
