import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import {
  createError,
  defineEventHandler,
  getRouterParam,
  readBody,
  setResponseStatus,
} from "nitro/h3";
import { requireAppUser } from "../../../../../lib/auth-gate.js";

type WriteBody = {
  uri?: unknown;
  markdown?: unknown;
  actorTurnId?: unknown;
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
  if (typeof body.actorTurnId !== "string" || body.actorTurnId.length === 0) {
    throw createError({ statusCode: 400, message: "actorTurnId is required" });
  }

  const context = app.contextPorts.forThread({ threadId, userId: user.userId });
  const response = await context.writeDocument({
    uri: body.uri,
    markdown: body.markdown,
    origin: { type: "agent", actorTurnId: body.actorTurnId as TurnId },
  });
  setResponseStatus(event, 202);
  return response;
});
