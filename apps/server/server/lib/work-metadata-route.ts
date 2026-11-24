import type { CommandId } from "@meridian/contracts";
import type { Settlement } from "@meridian/contracts/commands";
import type { UserId, WorkId } from "@meridian/contracts/runtime";
import type { Work } from "@meridian/contracts/works";
import { createError } from "nitro/h3";
import {
  requireWorkOwner,
  updateWorkTransition,
  type WorkContextNotices,
  WorkNameRequiredError,
  type WorkRepository,
} from "../domains/projects/index.js";
import type { ProjectRepository } from "../domains/projects/ports/project-repository.js";
import type { CommandStore } from "../shared/commands/drizzle-commands.js";
import { orReturnedWhenClosed, runWorkCommand } from "./work-command.js";
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
): Promise<{ work?: Work; settled?: Settlement[] }> {
  try {
    const work = await requireWorkOwner(deps, input.workId, input.userId, {
      includeSoftDeleted: true,
    });
    return await runWorkCommand(
      deps.commands,
      {
        commandId: input.commandId,
        userId: input.userId,
        projectId: work.projectId,
        kind: "work_update",
        workId: input.workId,
        body: { name: input.name, goal: input.goal },
      },
      () =>
        orReturnedWhenClosed(deps.works, input.workId, async () => {
          const { after } = await updateWorkTransition(deps, input.workId, {
            name: input.name,
            goal: input.goal,
          });
          return { work: after };
        }),
    );
  } catch (error) {
    if (error instanceof WorkNameRequiredError) {
      throw createError({ statusCode: 400, message: error.message });
    }
    throwWorkMutationHttpError(error);
  }
}
