/** Authenticated writer adapter for the canonical thread Work-rebind command. */
import type { UserId, WorkId } from "@meridian/contracts/runtime";
import type {
  RebindThreadWorkRequest,
  RebindThreadWorkResponse,
  ThreadBusyErrorResponse,
} from "@meridian/contracts/works";
import { createError } from "nitro/h3";
import type { ProjectPreferencesRepository } from "../domains/preferences/index.js";
import type { ProjectRepository, WorkRepository } from "../domains/projects/index.js";
import {
  rebindThreadWork,
  requireThreadOwner,
  type ThreadRepository,
  type ThreadWorkContextUpdates,
  ThreadWorkRebindUnavailableError,
  type ThreadWorksRepository,
} from "../domains/threads/index.js";
import { requireRequestId } from "./request-id.js";

export interface ThreadWorkRebindRouteDeps {
  threads: Pick<ThreadRepository, "findById">;
  threadWorks: Pick<ThreadWorksRepository, "rebindPrimary">;
  projects: ProjectRepository;
  works: Pick<WorkRepository, "findById">;
  preferences: Pick<ProjectPreferencesRepository, "setCurrentWorkId">;
  contextUpdates: ThreadWorkContextUpdates;
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  isThreadRunning(threadId: string): boolean;
}

export function parseRebindThreadWorkRequest(raw: unknown): RebindThreadWorkRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw createError({ statusCode: 400, message: "Request body must be an object" });
  }
  const body = raw as Record<string, unknown>;
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "workId") {
    throw createError({ statusCode: 400, message: "Request body must contain only `workId`" });
  }
  return { workId: requireRequestId(body.workId, "workId") as WorkId };
}

export async function handleRebindThreadWorkRequest(
  deps: ThreadWorkRebindRouteDeps,
  input: {
    threadId: string;
    userId: UserId;
    body: RebindThreadWorkRequest;
  },
): Promise<RebindThreadWorkResponse> {
  const thread = await requireThreadOwner(
    { threads: deps.threads, projects: deps.projects },
    input.threadId,
    input.userId,
  );
  if (deps.isThreadRunning(thread.id)) {
    const body: ThreadBusyErrorResponse = {
      code: "thread_busy",
      message: "This thread is currently generating a response. Stop it or wait, then retry.",
      retryable: true,
    };
    throw createError({ statusCode: 409, statusMessage: "Thread busy", data: body });
  }

  try {
    return await rebindThreadWork(deps, {
      threadId: thread.id,
      targetWorkId: input.body.workId,
      preferenceUserId: input.userId,
    });
  } catch (cause) {
    if (cause instanceof ThreadWorkRebindUnavailableError) {
      throw createError({ statusCode: 404, message: "Thread or Work not found" });
    }
    throw cause;
  }
}
