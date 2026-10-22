/**
 * IdentityContinuity — what this device remembers by document id follows a join or remint.
 *
 * A join makes the id this device minted an alias of the document the server holds, and the
 * server never saw the alias. A recent route or a Recently opened row still carrying it would be
 * sent, and refused, for ever. This account-lifetime owner reads the current projection, never a
 * remembered transition: a stored id is rewritten only when the projection's canonical index
 * resolves it to a different current identity, so an id some record holds as its own is never
 * moved. It reconciles whenever the projection changes or a store hydrates or changes, because
 * the stored id may arrive after the projection did.
 */
import type { WorkingSetRoute } from "@meridian/contracts/protocol";
import {
  type ResourceIdentityIndex,
  type ResourceRecord,
  resourceIdentityIndex,
} from "@meridian/resource-replica";
import {
  followAccountRecentIdentity,
  getAccountRecentsSnapshot,
  subscribeAccountRecents,
} from "@/client/recents";
import {
  followRouteIdentity,
  readRecentRoutes,
  replaceRecentRoutes,
  subscribeWorkingSetHydration,
} from "@/client/working-set";
import type { AccountResourceReplica } from "@/core/resources/account-resource-replica";

export class IdentityContinuity {
  private index: ResourceIdentityIndex | null = null;
  private projectIds: ReadonlySet<string> = new Set();
  private readonly stops: (() => void)[];

  constructor(
    private readonly accountId: string,
    resources: Pick<AccountResourceReplica, "onProjection">,
  ) {
    this.stops = [
      resources.onProjection((records) => {
        this.index = resourceIdentityIndex(records);
        this.projectIds = projectsOf(records);
        this.reconcileRecents();
        for (const projectId of this.projectIds) this.reconcileRoutes(projectId);
      }),
      subscribeAccountRecents(() => this.reconcileRecents()),
      subscribeWorkingSetHydration((projectId) => this.reconcileRoutes(projectId)),
    ];
  }

  dispose(): void {
    for (const stop of this.stops) stop();
  }

  /** The id a stored one answers to now, or null when it already is current or is unknown. */
  private currentIdOf(projectId: string, stored: string): string | null {
    let owner: ResourceRecord | null;
    try {
      owner = this.index?.byDocumentId(stored) ?? null;
    } catch {
      return null; // Ambiguous ownership names no safe destination.
    }
    const current = owner?.resource.identity.documentId;
    return owner?.intents[0]?.projectId === projectId && current && current !== stored
      ? current
      : null;
  }

  private reconcileRecents(): void {
    for (const { projectId, documentId } of getAccountRecentsSnapshot().items) {
      const to = this.currentIdOf(projectId, documentId);
      if (to) followAccountRecentIdentity(this.accountId, projectId, documentId, to);
    }
  }

  private reconcileRoutes(projectId: string): void {
    const stored = readRecentRoutes(projectId);
    let routes: readonly WorkingSetRoute[] = stored;
    for (const { documentId } of routes) {
      const to = this.currentIdOf(projectId, documentId);
      if (to) routes = followRouteIdentity(routes, documentId, to);
    }
    if (routes !== stored) replaceRecentRoutes(projectId, routes);
  }
}

function projectsOf(records: readonly ResourceRecord[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const record of records) {
    const projectId = record.intents[0]?.projectId;
    if (projectId) ids.add(projectId);
  }
  return ids;
}
