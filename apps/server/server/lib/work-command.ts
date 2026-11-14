/**
 * Work commands: each lifecycle request claims its id in the transaction that changes the Work
 * (`runRouteCommand`). A Work command stores the Work as the writer should see it and, when the
 * asked state already held, an `already` settlement. The one refusal left is the No Work lock; it
 * is stored with the command and thrown again as the same domain error on every resend, so the
 * route's one error mapping answers the first request and every resend alike.
 */
import type { CommandId, ProjectId, UserId } from "@meridian/contracts";
import type { CommandKind, Settlement } from "@meridian/contracts/commands";
import type { WorkId } from "@meridian/contracts/runtime";
import type { Work } from "@meridian/contracts/works";
import {
  WorkLifecycleUnavailableError,
  WorkLockedError,
  type WorkRepository,
} from "../domains/projects/index.js";
import type { CommandStore } from "../shared/commands/drizzle-commands.js";
import { runRouteCommand } from "./command-route.js";

/** What a Work command stores: the Work (none for a delete), what settled, or its refusal. */
type WorkCommandResult =
  | { status: "done"; work?: Work; settled?: Settlement[] }
  | { status: "refused"; refusal: { error: "locked" } };

function refusalOf(cause: unknown): WorkCommandResult | undefined {
  return cause instanceof WorkLockedError
    ? { status: "refused", refusal: { error: "locked" } }
    : undefined;
}

/** The settlement a second press stores: the lifecycle state the Work was already in. */
export function already(state: string): { settled: Settlement[] } {
  return { settled: [{ rule: "already", state }] };
}

/**
 * Runs `effect` as the Work command `kind`, in one transaction that starts with the claim.
 * Answers the Work the command made (none for a delete) or throws the domain error that refused
 * it. The effect lists what settled differently from the ask.
 * `body` is the request's body without its `commandId`: a resend must carry the same one.
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
  effect: () => Promise<{ work?: Work; settled?: Settlement[] }>,
): Promise<Work | undefined> {
  const result = await runRouteCommand<WorkCommandResult>(
    store,
    { ...input, selectors: { workId: input.workId ?? null } },
    async () => {
      const { work, settled } = await effect();
      return { status: "done", ...(work && { work }), ...(settled && { settled }) };
    },
    refusalOf,
  );
  if (result.status === "refused") throw new WorkLockedError();
  return result.work;
}

/**
 * A command on a closed Work changes nothing: it is done, and the result is the Work as it stands
 * with a `returned` settlement, so the client keeps what the writer typed or clicked. A purged
 * Work still throws.
 */
export async function orReturnedWhenClosed(
  works: WorkRepository,
  workId: WorkId,
  effect: () => Promise<{ work?: Work; settled?: Settlement[] }>,
): Promise<{ work?: Work; settled?: Settlement[] }> {
  try {
    return await effect();
  } catch (cause) {
    if (cause instanceof WorkLifecycleUnavailableError && cause.state !== "missing") {
      const work = await works.findById(workId);
      if (work) {
        return {
          work,
          settled: [
            {
              rule: "returned",
              why: cause.state === "archived" ? "work_archived" : "work_deleted",
            },
          ],
        };
      }
    }
    throw cause;
  }
}
