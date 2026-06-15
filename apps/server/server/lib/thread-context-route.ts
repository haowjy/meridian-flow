import type { ThreadId, UserId } from "@meridian/contracts/runtime";
import { createError } from "nitro/h3";
import {
  contextPortForThread,
  resolveThreadContext,
} from "../domains/context/context-port-resolution.js";
import type { ContextError } from "../domains/context/ports/context-port.js";
import type { UnifiedContextPortFactory } from "../domains/context/unified-context-port-factory.js";
import type { ThreadRepository, ThreadWorksRepository } from "../domains/threads/index.js";

export interface ThreadContextRouteDeps {
  contextPorts: UnifiedContextPortFactory;
  threads: Pick<ThreadRepository, "findById">;
  threadWorks: Pick<ThreadWorksRepository, "findPrimary" | "listByThread">;
}

function contextErrorToHttp(error: ContextError): never {
  switch (error.code) {
    case "invalid_uri":
      throw createError({ statusCode: 400, message: error.reason });
    case "permission_denied":
      throw createError({ statusCode: 403, message: "Context access denied" });
    case "not_found":
      throw createError({ statusCode: 404, message: "Document not found" });
    case "context_unavailable":
      throw createError({ statusCode: 503, message: "Context is unavailable" });
    case "io_error":
      throw createError({ statusCode: 502, message: error.message });
  }
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
  const port = await resolveThreadContextPort(deps, input.threadId, input.userId);
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
  const port = await resolveThreadContextPort(deps, input.threadId, input.userId);
  const result = await port.write(input.uri, input.markdown, {
    origin: { type: "human", userId: input.userId },
  });
  if (!result.ok) contextErrorToHttp(result.error);
  return {
    documentId: result.value.documentId,
    uri: input.uri,
    markdown: input.markdown,
    updateSeq: 0,
  };
}
