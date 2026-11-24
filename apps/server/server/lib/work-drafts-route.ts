/**
 * Route core for a Work's drafts (`WorkDrafts`): the list, and each change as a command whose
 * resend answers what it stored. Nothing here decides an effect.
 */
import type { CommandId, DraftId, ProjectId, UserId, WorkId } from "@meridian/contracts";
import { isDraftId } from "@meridian/contracts";
import type { CommandKind } from "@meridian/contracts/commands";
import type { DraftCommandResult, WorkDraft, WorkDraftsResponse } from "@meridian/contracts/drafts";
import { createError } from "nitro/h3";
import { requireWorkOwner } from "../domains/projects/index.js";
import type { AppServices } from "./app.js";
import { runRouteCommand, splitCommandBody } from "./command-route.js";
import { requireRequestId } from "./request-id.js";
import { throwWorkMutationHttpError } from "./work-http.js";

type Services = Pick<AppServices, "workRepo" | "projectRepo" | "commands" | "documentSync">;

async function ownedWork(app: Services, workId: string | undefined, userId: UserId) {
  const id = requireRequestId(workId, "workId") as WorkId;
  try {
    return await requireWorkOwner({ works: app.workRepo, projects: app.projectRepo }, id, userId, {
      includeSoftDeleted: true,
    });
  } catch (error) {
    return throwWorkMutationHttpError(error);
  }
}

export function draftIdParam(raw: string | undefined): DraftId {
  if (!raw || !isDraftId(raw)) throw createError({ statusCode: 400, message: "Invalid draft" });
  return raw;
}

export async function handleListWorkDrafts(
  app: Services,
  input: { workId: string | undefined; userId: UserId },
): Promise<WorkDraftsResponse> {
  const work = await ownedWork(app, input.workId, input.userId);
  return { drafts: await app.documentSync.workDrafts.list(work.id as WorkId) };
}

/** Runs one draft change as the command `kind` on the Work the route names. */
export async function runDraftCommand(
  app: Services,
  input: {
    workId: string | undefined;
    userId: UserId;
    kind: Extract<CommandKind, `draft_${string}`>;
    rawBody: unknown;
    draftId?: DraftId;
  },
  effect: (
    work: { id: WorkId; projectId: ProjectId },
    body: Record<string, unknown>,
  ) => Promise<WorkDraft | null>,
): Promise<DraftCommandResult> {
  const work = await ownedWork(app, input.workId, input.userId);
  const { commandId, body } = splitCommandBody(input.rawBody);
  return runRouteCommand<DraftCommandResult>(
    app.commands,
    {
      commandId: commandId as CommandId,
      userId: input.userId,
      projectId: work.projectId as ProjectId,
      kind: input.kind,
      selectors: { workId: work.id, draftId: input.draftId ?? null },
      body,
    },
    async () => ({
      status: "done",
      draft: await effect({ id: work.id as WorkId, projectId: work.projectId as ProjectId }, body),
    }),
    () => undefined,
  );
}

/** A draft's name from a body: a string, or null for the default name. */
export function draftName(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || raw.length > 200)
    throw createError({ statusCode: 400, message: "name must be a string" });
  return raw.trim() === "" ? null : raw.trim();
}
