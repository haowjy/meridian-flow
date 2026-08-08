/** PUT /api/threads/:threadId/work: idempotently rebinds an idle owned thread. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import {
  handleRebindThreadWorkRequest,
  parseRebindThreadWorkRequest,
} from "../../../../lib/thread-work-rebind-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const result = await handleRebindThreadWorkRequest(
    {
      threads: app.repos.threads,
      threadWorks: app.repos.threadWorks,
      projects: app.projectRepo,
      works: app.workRepo,
      preferences: app.preferences,
      contextUpdates: {
        threadChanged: (threadId) => app.systemUpdates.threadChanged(threadId),
        flush: (threadId) => app.systemUpdates.flush(threadId),
        isPending: (threadId) => app.repos.workContextDeliveries.isPending(threadId),
      },
      transaction: app.repos.transaction,
      isThreadRunning: (threadId) => app.runner.isThreadRunning(threadId),
    },
    {
      threadId: getRouterParam(event, "threadId") ?? "",
      userId: user.userId,
      body: parseRebindThreadWorkRequest(await readBody(event)),
    },
  );
  return serializeTransport(result);
});
