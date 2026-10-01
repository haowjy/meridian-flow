/** GET /api/threads/:threadId/transcript: an authenticated keyset page. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getQuery, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { handleReadThreadTranscript } from "../../../../lib/thread-transcript-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  return serializeTransport(
    await handleReadThreadTranscript(
      { repos: app.repos, threads: app.repos.threads, projects: app.projectRepo },
      {
        threadId: getRouterParam(event, "threadId") ?? "",
        userId: user.userId,
        query: getQuery(event),
      },
    ),
  );
});
