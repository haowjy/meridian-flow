import type { Settlement } from "@meridian/contracts/commands";
import { LineageDraftsUnavailableError } from "../../../shared/draft-owner.js";
import { WorkLifecycleUnavailableError } from "../../projects/index.js";

/**
 * A Discard or Undo of a Discard on drafts whose owner is closed (an archived or deleted Work,
 * a chat in Trash) changes nothing: the Work lock throws, and this is the `returned` the command
 * stores in place of the throw. Any other cause is not a closed owner's, and is undefined.
 */
export function closedOwnerBounce(cause: unknown): Settlement[] | undefined {
  if (cause instanceof LineageDraftsUnavailableError)
    return [{ rule: "returned", why: "chat_frozen" }];
  if (cause instanceof WorkLifecycleUnavailableError && cause.state !== "missing")
    return [
      { rule: "returned", why: cause.state === "archived" ? "work_archived" : "work_deleted" },
    ];
  return undefined;
}
