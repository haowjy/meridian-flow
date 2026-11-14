/**
 * Work commands: each lifecycle request claims its id in the transaction that changes the Work
 * (`runRouteCommand`). A refusal raised inside the change is stored with the command and thrown
 * again as the same domain error on every resend, so the route's one error mapping answers the
 * first request and every resend alike.
 */
import type { CommandId, ProjectId, UserId } from "@meridian/contracts";
import type { CommandKind } from "@meridian/contracts/commands";
import type { Work } from "@meridian/contracts/works";
import {
  WorkLifecycleUnavailableError,
  WorkLockedError,
  WorkNameConflictError,
  WorkRestoreConflictError,
  WorkRestoreExpiredError,
} from "../domains/projects/index.js";
import type { CommandStore } from "../shared/commands/drizzle-commands.js";
import { runRouteCommand } from "./command-route.js";

type WorkRefusal =
  | { error: "name_conflict" | "restore_conflict" | "restore_expired" | "locked" }
  | {
      error: "unavailable";
      workId: string;
      state: WorkLifecycleUnavailableError["state"];
      handle: string | null;
    };

/** What a Work command stores: the Work as the writer saw it (none for a delete), or its refusal. */
type WorkCommandResult =
  | { status: "done"; work?: Work }
  | { status: "refused"; refusal: WorkRefusal };

function refusalOf(cause: unknown): WorkCommandResult | undefined {
  const refusal = refusalFields(cause);
  return refusal && { status: "refused", refusal };
}

function refusalFields(cause: unknown): WorkRefusal | undefined {
  if (cause instanceof WorkNameConflictError) return { error: "name_conflict" };
  if (cause instanceof WorkRestoreConflictError) return { error: "restore_conflict" };
  if (cause instanceof WorkRestoreExpiredError) return { error: "restore_expired" };
  if (cause instanceof WorkLockedError) return { error: "locked" };
  if (cause instanceof WorkLifecycleUnavailableError)
    return {
      error: "unavailable",
      workId: cause.workId,
      state: cause.state,
      handle: cause.workHandle,
    };
  return undefined;
}

function errorOf(refusal: WorkRefusal): Error {
  switch (refusal.error) {
    case "name_conflict":
      return new WorkNameConflictError();
    case "restore_conflict":
      return new WorkRestoreConflictError();
    case "restore_expired":
      return new WorkRestoreExpiredError();
    case "locked":
      return new WorkLockedError();
    case "unavailable":
      return new WorkLifecycleUnavailableError(refusal.workId, refusal.state, refusal.handle);
  }
}

/**
 * Runs `effect` as the Work command `kind`, in one transaction that starts with the claim.
 * Answers the Work the command made (none for a delete) or throws the domain error that refused
 * it. `body` is the request's body without its `commandId`: a resend must carry the same one.
 */
export async function runWorkCommand(
  store: CommandStore,
  input: {
    commandId: CommandId;
    userId: UserId;
    projectId: ProjectId;
    kind: Extract<CommandKind, `work_${string}`>;
    workId?: string;
    body: unknown;
  },
  effect: () => Promise<Work | undefined>,
): Promise<Work | undefined> {
  const result = await runRouteCommand<WorkCommandResult>(
    store,
    { ...input, selectors: { workId: input.workId ?? null } },
    async () => {
      const work = await effect();
      return work ? { status: "done", work } : { status: "done" };
    },
    refusalOf,
  );
  if (result.status === "refused") throw errorOf(result.refusal);
  return result.work;
}
