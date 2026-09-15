# Working-set client

The working-set module is the device-local restore truth for a project's recent
document routes and remembered thread. `DeviceWorkingSetStore` owns the
user-stamped persisted record; `WorkingSetSyncDriver` owns server baselines,
pending reports, hydration, and serialized sweeps.

The versioned local record and server row carry the same canonical route DTO:
stable document identity plus its current locator. Obsolete locator-only local
values and pre-migration server rows are deleted rather than decoded.

Live context removal uses `reconcileContextRoutes`: one snapshot transform removes
only identities with no surviving tab owner, repairs a same-ID locator in place, optionally promotes the resulting
active route, and clears all routes only for a genuinely empty workspace. Callers must
not compose remove/promote operations for one removal transition; the sequential
driver surface is intentionally absent.

## Hydration contract

`ReadableProjectRoute` hydrates the working set synchronously at project entry.
The reducer uses server revision lineage: unavailable stays local and cannot
push, absent keeps local, matching pending lineage keeps local, and every other
row adopts server. The account sync toggle guards the operation.

Server adoption updates recency and the remembered thread, not Editor tab
membership. `selectEditorEntryTab` may rank existing tabs using recent routes;
it never reopens a historical path. An empty browser-local workspace stays empty
through screen entry and reload. Project-entry validation reconciles only tabs
already restored from sessionStorage against the resource replica.

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

Entry hydration in `ReadableProjectRoute` is unchanged for UI plans, but when a project
is suspect the driver does not confirm baselines from loader results — stale
router cache cannot resurrect a trustworthy baseline mid-session.
