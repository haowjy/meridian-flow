/** Authenticated writer adapter for the canonical thread Work-rebind command. */

import { meridianError, meridianErrorFromSystem } from "@meridian/contracts/protocol";
import type { UserId, WorkId } from "@meridian/contracts/runtime";
import type { RebindThreadWorkRequest, RebindThreadWorkResponse } from "@meridian/contracts/works";
import { createError } from "nitro/h3";
import type { NoticePort } from "../domains/notices/index.js";
import type {
  ProjectRepository,
  WorkContextDelivery,
  WorkRepository,
} from "../domains/projects/index.js";
import type { ThreadRunOwnership } from "../domains/runtime/index.js";
import {
  RebindThreadWorkError,
  rebindThreadWork,
  requireThreadOwner,
  type ThreadRepository,
  type ThreadWorksRepository,
  type WorkContextDeliveryRepository,
} from "../domains/threads/index.js";
import { throwHttpInterrupt } from "./interrupt-boundary.js";
import { requireRequestId } from "./request-id.js";
import { recordWriterWorkSwitchNotice } from "./writer-work-switch-notice.js";

export interface ThreadWorkRebindRouteDeps {
  threads: Pick<ThreadRepository, "findById">;
  threadWorks: Pick<ThreadWorksRepository, "rebindPrimary">;
  projects: Pick<ProjectRepository, "findById">;
  works: Pick<WorkRepository, "findById">;
  obligations: Pick<WorkContextDeliveryRepository, "enqueueThread">;
  workContextDelivery: Pick<WorkContextDelivery, "deliverAfterCommit">;
  notices: Pick<NoticePort, "record">;
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
  if (body.workId === null) return { target: { kind: "none" } };
  return {
    target: { kind: "work", workId: requireRequestId(body.workId, "workId") as WorkId },
  };
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
  if (input.body.target.kind === "work") {
    const target = await deps.works.findById(input.body.target.workId);
    if (!target || target.deletedAt || target.projectId !== thread.projectId) {
      throwHttpInterrupt(meridianErrorFromSystem("not_found", "Thread or Work not found"), 404);
    }
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
  let transition: Awaited<ReturnType<typeof rebindThreadWork>>;
  try {
    transition = await deps.transaction(async () => {
      const rebound = await rebindThreadWork(deps, {
        threadId: thread.id,
        target: input.body.target,
      });
      await recordWriterWorkSwitchNotice(deps.notices, rebound);
      return rebound;
    });
  } catch (cause) {
    if (cause instanceof RebindThreadWorkError && cause.code === "thread_unavailable") {
      throwHttpInterrupt(meridianErrorFromSystem("not_found", "Thread or Work not found"), 404);
    }
    if (cause instanceof RebindThreadWorkError && cause.code === "project_mismatch") {
      throwHttpInterrupt(meridianErrorFromSystem("not_found", "Thread or Work not found"), 404);
    }
    if (cause instanceof RebindThreadWorkError && cause.code === "target_work_unavailable") {
      throwHttpInterrupt(
        meridianError({
          code: "work_unavailable",
          message: "That Work is no longer available. Refresh Work and choose another.",
          source: "system",
          details: { refresh: "works" },
        }),
        409,
      );
    }
    throw cause;
  } finally {
    await claim.release();
  }
  if (!transition.changed) return { ...transition, contextUpdate: "not_required" };
  const contextUpdate = await deps.workContextDelivery.deliverAfterCommit(transition.threadId);
  return { ...transition, contextUpdate };
}
