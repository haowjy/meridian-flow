# Working-set client

The working-set module is the device-local restore truth for a project's recent
document routes and remembered thread. `DeviceWorkingSetStore` owns the
user-stamped persisted record; `WorkingSetSyncDriver` owns server baselines,
pending reports, hydration, and serialized sweeps.

## Hydration contract

`ProjectView`, keyed by project ID, invokes hydration synchronously in its state
initializer before the prefs-gated project tree can mount. The reducer uses only
server revision lineage: unavailable stays local and cannot push, absent keeps
local, matching pending lineage keeps local, and every other row adopts server.
The account toggle guards the whole operation. Server adoption changes store
state but never navigates; restore remains owned by the existing context and
chat controllers.

Server-adopted routes are a seeding plan, not navigation instructions. The
project layer resolves each against its live context tree, opens it inactive,
and checks that the route remains desired immediately before the async commit.
Work-scoped routes are meaningful only when their stored work matches the live
route work.

## Suspect baseline (recovery sweep errata)

Design reference: `client-engine.md` § the sweep — the happy path stays
unconditional LWW; this rule applies only on recovery paths.

A project's in-memory baseline becomes **suspect** when:

1. a PUT fails (any error, including network),
2. the browser fires `online` after an offline period,
3. sync is re-enabled after the account toggle was off (baselines are cleared;
   entry hydration must re-establish before push — same gate, folded here).

While suspect, the sweep must not PUT. Before the next push it performs a fresh
network GET (standalone `getProjectWorkingSet`, not router-cached loader data),
then runs `planSuspectBaselineConfirmation` / `reduceWorkingSetHydration`:

- **local** (absent, or pending base matches row) → baseline confirmed; push proceeds.
- **server** (row moved past pending's base) → adopt row into the store (data
  only — no navigation, seeding, or tab changes), discard pending, confirm the
  new revision as baseline.
- **read-degraded** (GET fails) → stay suspect; backoff; retry on `online` or
  the next sweep.

Entry hydration in `ProjectView` is unchanged for UI plans, but when a project
is suspect the driver does not confirm baselines from loader results — stale
router cache cannot resurrect a trustworthy baseline mid-session.
