/** Route core for writer-owned Work metadata changes and their coded refusal envelopes. */
import type { CommandId } from "@meridian/contracts";
import type { UserId, WorkId } from "@meridian/contracts/runtime";
import type { Work } from "@meridian/contracts/works";
import { createError } from "nitro/h3";
import {
  requireWorkOwner,
  updateWorkTransition,
  type WorkContextNotices,
  WorkLifecycleUnavailableError,
  WorkNameRequiredError,
  type WorkRepository,
} from "../domains/projects/index.js";
import type { ProjectRepository } from "../domains/projects/ports/project-repository.js";
import type { CommandStore } from "../shared/commands/drizzle-commands.js";
import { runWorkCommand } from "./work-command.js";
import { throwWorkMutationHttpError } from "./work-http.js";

export async function updateWorkMetadataForWriter(
  deps: {
    commands: CommandStore;
    works: WorkRepository;
    projects: ProjectRepository;
    workContextNotices: Pick<WorkContextNotices, "workChanged">;
  },
  input: {
    commandId: CommandId;
    workId: WorkId;
    userId: UserId;
    name?: string;
    goal?: string;
  },
): Promise<Work> {
  try {
    const work = await requireWorkOwner(deps, input.workId, input.userId, {
      includeSoftDeleted: true,
    });
    const updated = await runWorkCommand(
      deps.commands,
      {
        commandId: input.commandId,
        userId: input.userId,
        projectId: work.projectId,
        kind: "work_update",
        workId: input.workId,
        body: { name: input.name, goal: input.goal },
      },
      async () => {
        try {
          const { after } = await updateWorkTransition(deps, input.workId, {
            name: input.name,
            goal: input.goal,
          });
          return { work: after };
        } catch (cause) {
          // A closed Work takes no change: the command is done, the Work stays as it stands, and
          // the result says why, so the client keeps the writer's typed words.
          if (cause instanceof WorkLifecycleUnavailableError && cause.state !== "missing") {
            const work = await deps.works.findById(input.workId);
            if (!work) throw cause;
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
          throw cause;
        }
      },
    );
    return updated as Work;
  } catch (error) {
    if (error instanceof WorkNameRequiredError) {
      throw createError({ statusCode: 400, message: error.message });
    }
    throwWorkMutationHttpError(error);
  }
}
