/** The lifecycle errors of a Work or chat, as the refusal a command answers. */
import { LineageDraftsUnavailableError } from "../../../shared/draft-owner.js";
import { WorkLifecycleUnavailableError } from "../../projects/index.js";
import { ApplyClickRefused } from "../domain/apply-click.js";

/** A Work or chat that cannot take the command is a final refusal; anything else is rethrown. */
export function asLifecycleRefusal(cause: unknown): unknown {
  if (cause instanceof LineageDraftsUnavailableError) return new ApplyClickRefused("chat_frozen");
  if (cause instanceof WorkLifecycleUnavailableError)
    return new ApplyClickRefused(
      cause.state === "archived"
        ? "work_archived"
        : cause.state === "deleted"
          ? "work_deleted"
          : "not_found",
    );
  return cause;
}
