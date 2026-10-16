/** Request options for context schemes with an explicit owner: a Work or lineage's Scratch, or a chat's uploads. */

import { isOwnedContextScheme } from "@meridian/contracts/context-uri";
import type { ContextOwner, ProjectContextTreeScheme } from "@meridian/contracts/protocol";

export type { ContextOwner };

/** The owner flattened for an HTTP request: an owned scheme needs one. */
export function contextRequestOptionsForScheme(
  scheme: ProjectContextTreeScheme,
  owner: ContextOwner,
):
  | { workId: string; rootThreadId?: undefined; chatThreadId?: undefined }
  | { workId?: undefined; rootThreadId: string; chatThreadId?: undefined }
  | { workId?: undefined; rootThreadId?: undefined; chatThreadId: string }
  | undefined {
  if (!isOwnedContextScheme(scheme)) return undefined;
  if (scheme === "uploads") {
    if (!owner.chatThreadId) throw new Error("Uploads reads require a chat id");
    return { chatThreadId: owner.chatThreadId };
  }
  if (owner.rootThreadId) return { rootThreadId: owner.rootThreadId };
  if (!owner.workId) throw new Error("Scratch reads require a Work row id or a lineage");
  return { workId: owner.workId };
}
