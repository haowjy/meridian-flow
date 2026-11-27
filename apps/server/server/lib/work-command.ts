import type { CommandId, ProjectId, UserId } from "@meridian/contracts";
import type { CommandKind, Settlement } from "@meridian/contracts/commands";
import type { WorkId } from "@meridian/contracts/runtime";
import type { Work } from "@meridian/contracts/works";
import { WorkLockedError, type WorkRepository } from "../domains/projects/index.js";
import type { CommandStore } from "../shared/commands/drizzle-commands.js";
import { WorkLifecycleUnavailableError } from "../shared/work-lifecycle-lock.js";
import { runRouteCommand } from "./command-route.js";

type WorkCommandResult =
  | { status: "done"; work?: Work; settled?: Settlement[] }
  | { status: "refused"; refusal: { error: "locked" } };

function refusalOf(cause: unknown): WorkCommandResult | undefined {
  return cause instanceof WorkLockedError
    ? { status: "refused", refusal: { error: "locked" } }
    : undefined;
}

export function already(state: string): { settled: Settlement[] } {
  return { settled: [{ rule: "already", state }] };
}

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
): Promise<{ work?: Work; settled?: Settlement[] }> {
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
  return { work: result.work, settled: result.settled };
}

export function workAnswer({ work, settled }: { work?: Work; settled?: Settlement[] }) {
  if (!work) throw new Error("A Work command answers its Work");
  return settled ? { ...work, settled } : work;
}

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
