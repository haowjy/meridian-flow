/**
 * useFollowJoinedIdentities — what the device remembers by document id follows a join.
 *
 * A join makes the id this device minted an alias of the document the server holds.
 * The server never saw the alias (it only forwards one create), so a recent route
 * or a recently opened row still carrying it would be sent, and refused, for ever.
 * The replica's aliases are the evidence: each stored id that is an alias becomes
 * its current id, whenever the projection changes.
 */
import { useEffect } from "react";
import { followAccountRecentIdentity } from "@/client/recents";
import {
  useAccountId,
  useAccountResourceProjection,
  useContextRemovalCoordinator,
} from "./account-feature-context";

export function useFollowJoinedIdentities(projectId: string): void {
  const accountId = useAccountId();
  const removal = useContextRemovalCoordinator();
  const { records } = useAccountResourceProjection(projectId);
  useEffect(() => {
    for (const { resource } of records) {
      for (const alias of Object.keys(resource.aliases)) {
        // Recent routes are the working set's; the coordinator owns that write.
        removal.followResourceIdentity(projectId, alias, resource.identity.documentId);
        followAccountRecentIdentity(accountId, projectId, alias, resource.identity.documentId);
      }
    }
  }, [accountId, projectId, records, removal]);
}
