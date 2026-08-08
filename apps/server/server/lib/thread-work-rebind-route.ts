/** Authenticated writer adapter for the canonical thread Work-rebind command. */

import { meridianError, meridianErrorFromSystem } from "@meridian/contracts/protocol";
import type { UserId, WorkId } from "@meridian/contracts/runtime";
import type { RebindThreadWorkRequest, RebindThreadWorkResponse } from "@meridian/contracts/works";
import { createError } from "nitro/h3";
import type { ProjectPreferencesRepository } from "../domains/preferences/index.js";
import type { ProjectRepository, WorkRepository } from "../domains/projects/index.js";
import type { ThreadRunOwnership } from "../domains/runtime/index.js";
import {
  applyRebindThreadWorkTransition,
  finishRebindThreadWork,
  MissingPrimaryWorkMembershipError,
  requireThreadOwner,
  type ThreadRepository,
  type ThreadWorkContextUpdates,
  ThreadWorkRebindTargetUnavailableError,
  ThreadWorkRebindUnavailableError,
  type ThreadWorksRepository,
} from "../domains/threads/index.js";
import { throwHttpInterrupt } from "./interrupt-boundary.js";
import { requireRequestId } from "./request-id.js";

export interface ThreadWorkRebindRouteDeps {
  threads: Pick<ThreadRepository, "findById">;
  threadWorks: Pick<ThreadWorksRepository, "rebindPrimary">;
  projects: ProjectRepository;
  works: Pick<WorkRepository, "findById">;
  preferences: Pick<ProjectPreferencesRepository, "setCurrentWorkId">;
  contextUpdates: ThreadWorkContextUpdates;
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  runOwnership: ThreadRunOwnership;
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
  const target = await deps.works.findById(input.body.workId);
  if (!target || target.deletedAt || target.projectId !== thread.projectId) {
    throwHttpInterrupt(meridianErrorFromSystem("not_found", "Thread or Work not found"), 404);
  }

  const claim = await deps.runOwnership.tryAcquire(thread.id);
  if (!claim) {
    throwHttpInterrupt(
      meridianErrorFromSystem(
        "thread_busy",
        "This thread is currently generating a response. Stop it or wait, then retry.",
        true,
      ),
      409,
    );
  }
  let transition: Awaited<ReturnType<typeof applyRebindThreadWorkTransition>>;
  try {
    transition = await deps.transaction(() =>
      applyRebindThreadWorkTransition(deps, {
        threadId: thread.id,
        targetWorkId: input.body.workId,
        preferenceUserId: input.userId,
      }),
    );
  } catch (cause) {
    if (cause instanceof ThreadWorkRebindUnavailableError) {
      throwHttpInterrupt(meridianErrorFromSystem("not_found", "Thread or Work not found"), 404);
    }
    if (cause instanceof ThreadWorkRebindTargetUnavailableError) {
      throwHttpInterrupt(
        meridianError({
          code: "work_unavailable",
          message: "That Work is no longer available. Refresh Works and choose another.",
          source: "system",
          details: { refresh: "works" },
        }),
        409,
      );
    }
    if (cause instanceof MissingPrimaryWorkMembershipError) {
      throwHttpInterrupt(
        meridianErrorFromSystem("thread_work_missing", "Conversation has no current Work"),
        409,
      );
    }
    throw cause;
  } finally {
    await claim.release();
  }
  return finishRebindThreadWork(deps.contextUpdates, transition);
}
