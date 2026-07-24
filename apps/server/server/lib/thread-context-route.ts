import type { ThreadId, UserId } from "@meridian/contracts/runtime";
import { createError } from "nitro/h3";
import {
  contextPortForThread,
  resolveThreadContext,
} from "../domains/context/context-port-resolution.js";
import type { UnifiedContextPortFactory } from "../domains/context/unified-context-port-factory.js";
import type { ThreadRepository, ThreadWorksRepository } from "../domains/threads/index.js";
import { contextErrorToHttp } from "./context-error-http.js";
import { requireRequestId } from "./request-id.js";

export interface ThreadContextRouteDeps {
  contextPorts: UnifiedContextPortFactory;
  threads: Pick<ThreadRepository, "findById">;
  threadWorks: Pick<ThreadWorksRepository, "findPrimary" | "listByThread">;
}

export async function resolveThreadContextPort(
  deps: ThreadContextRouteDeps,
  threadId: ThreadId,
  userId: UserId,
) {
  const resolution = await resolveThreadContext(
    { threads: deps.threads, threadWorks: deps.threadWorks },
    threadId,
  );
  if (!resolution || resolution.thread.userId !== userId) {
    throw createError({ statusCode: 404, message: "Thread not found" });
  }
  return contextPortForThread(deps.contextPorts, resolution);
}

export async function readThreadContextDocument(
  deps: ThreadContextRouteDeps,
  input: { threadId: ThreadId; userId: UserId; uri: string },
) {
  const threadId = requireRequestId(input.threadId, "threadId") as ThreadId;
  const port = await resolveThreadContextPort(deps, threadId, input.userId);
  const result = await port.read(input.uri);
  if (!result.ok) contextErrorToHttp(result.error);
  return {
    documentId: result.value.documentId,
    uri: input.uri,
    markdown: result.value.content,
  };
}

export async function writeThreadContextDocument(
  deps: ThreadContextRouteDeps,
  input: { threadId: ThreadId; userId: UserId; uri: string; markdown: string },
) {
  const threadId = requireRequestId(input.threadId, "threadId") as ThreadId;
  const port = await resolveThreadContextPort(deps, threadId, input.userId);
  const result = await port.write(input.uri, input.markdown, {
    origin: { type: "human", userId: input.userId, threadId },
  });
  if (!result.ok) contextErrorToHttp(result.error);
  return {
    documentId: result.value.documentId,
    uri: input.uri,
    markdown: result.value.markdown ?? input.markdown,
    updateSeq: result.value.updateSeq ?? 0,
  };
}
