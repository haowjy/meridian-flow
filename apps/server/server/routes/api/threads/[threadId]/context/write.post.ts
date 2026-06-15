import type { ThreadId } from "@meridian/contracts/runtime";
import {
  createError,
  defineEventHandler,
  getRouterParam,
  readBody,
  setResponseStatus,
} from "nitro/h3";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { writeThreadContextDocument } from "../../../../../lib/thread-context-route.js";

type WriteBody = {
  uri?: unknown;
  markdown?: unknown;
};

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const threadId = (getRouterParam(event, "threadId") ?? "") as ThreadId;
  const body = (await readBody<WriteBody>(event)) ?? {};
  if (typeof body.uri !== "string" || body.uri.length === 0) {
    throw createError({ statusCode: 400, message: "uri is required" });
  }
  if (typeof body.markdown !== "string") {
    throw createError({ statusCode: 400, message: "markdown is required" });
  }

  const response = await writeThreadContextDocument(
    {
      contextPorts: app.contextPorts,
      threads: app.threadRepos.threads,
      threadWorks: app.threadRepos.threadWorks,
    },
    {
      threadId,
      userId: user.userId,
      uri: body.uri,
      markdown: body.markdown,
    },
  );
  setResponseStatus(event, 202);
  return response;
});
