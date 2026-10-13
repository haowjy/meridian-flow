// Compile-only ownership contract: a response lease is not a runtime-store replica.
import type { ActorSession } from "../ports/actor-session-store.js";
import type { ResponseReadLease } from "./response-committer.js";
import type { RuntimeStore } from "./runtime-store.js";

declare const lease: ResponseReadLease;
declare const store: RuntimeStore;
declare const session: ActorSession;
// @ts-expect-error Prepared leases cannot reach runtime reconstruction.
store.restoreRuntimeFromLive(session, "chapter.md", lease, "read");
