/**
 * IdentityContinuity — what this device remembers by document id follows a join or remint.
 *
 * A join makes the id this device minted an alias of the document the server holds, and the
 * server never saw the alias. A recent route or a Recently opened row still carrying it would be
 * sent, and refused, for ever. The replica says which ids moved (and not those a real document
 * holds as its own); this account-lifetime owner moves the persisted references through the
 * stores' own reducers. It re-applies when a store hydrates or changes, because the stored id
 * may arrive after the change was observed.
 */
import { followAccountRecentIdentity, subscribeAccountRecents } from "@/client/recents";
import {
  followRouteIdentity,
  readRecentRoutes,
  replaceRecentRoutes,
  subscribeWorkingSetHydration,
} from "@/client/working-set";
import type { AccountResourceReplica } from "@/core/resources/account-resource-replica";

export class IdentityContinuity {
  /** project id → stored id → the id it answers to now. */
  private readonly followed = new Map<string, Map<string, string>>();
  private readonly stops: (() => void)[];

  constructor(
    private readonly accountId: string,
    resources: Pick<AccountResourceReplica, "onIdentityChanged">,
  ) {
    this.stops = [
      resources.onIdentityChanged(({ projectId, from, to }) => {
        const project = this.followed.get(projectId) ?? new Map<string, string>();
        project.set(from, to);
        this.followed.set(projectId, project);
        this.apply(projectId, from, to);
      }),
      subscribeAccountRecents(() => {
        for (const [projectId, project] of this.followed)
          for (const [from, to] of project)
            followAccountRecentIdentity(this.accountId, projectId, from, to);
      }),
      subscribeWorkingSetHydration((projectId) => {
        for (const [from, to] of this.followed.get(projectId) ?? [])
          this.followRoutes(projectId, from, to);
      }),
    ];
  }

  dispose(): void {
    for (const stop of this.stops) stop();
  }

  private apply(projectId: string, from: string, to: string): void {
    followAccountRecentIdentity(this.accountId, projectId, from, to);
    this.followRoutes(projectId, from, to);
  }

  private followRoutes(projectId: string, from: string, to: string): void {
    const routes = readRecentRoutes(projectId);
    const followed = followRouteIdentity(routes, from, to);
    if (followed !== routes) replaceRecentRoutes(projectId, followed);
  }
}
