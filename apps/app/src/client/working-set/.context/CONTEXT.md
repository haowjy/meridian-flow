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

