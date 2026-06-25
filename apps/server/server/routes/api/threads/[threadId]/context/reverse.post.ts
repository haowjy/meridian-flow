import { parseWriteHandle, type ReversalSelection, type WriteOutcome } from "@meridian/agent-edit";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import {
  createError,
  defineEventHandler,
  getRouterParam,
  readBody,
  setResponseStatus,
} from "nitro/h3";
import type { AppServices } from "../../../../../lib/app.js";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { readThreadContextDocument } from "../../../../../lib/thread-context-route.js";

type ReverseBody = {
  uri?: unknown;
  direction?: unknown;
  scope?: unknown;
  target?: unknown;
};

type ReverseRouteServices = {
  contextPorts: AppServices["contextPorts"];
  threads: AppServices["threadRepos"]["threads"];
  threadWorks: AppServices["threadRepos"]["threadWorks"];
  documentSync: AppServices["documentSync"];
};

function selectReverseRouteServices(app: AppServices): ReverseRouteServices {
  return {
    contextPorts: app.contextPorts,
    threads: app.threadRepos.threads,
    threadWorks: app.threadRepos.threadWorks,
    documentSync: app.documentSync,
  };
}

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const services = selectReverseRouteServices(app);
  const threadId = (getRouterParam(event, "threadId") ?? "") as ThreadId;
  const body = (await readBody<ReverseBody>(event)) ?? {};
  const input = parseReverseBody(body);

  const document = await readThreadContextDocument(
    {
      contextPorts: services.contextPorts,
      threads: services.threads,
      threadWorks: services.threadWorks,
    },
    { threadId, userId: user.userId, uri: input.uri },
  );
  if (!document.documentId) {
    throw createError({ statusCode: 404, message: "Document not found" });
  }

  const outcome = await services.documentSync.agentEdit().reverse({
    docId: document.documentId,
    threadId,
    direction: input.direction,
    selection: input.selection,
    actor: { type: "user", userId: user.userId },
  });

  setReverseStatus(event, outcome);
  if (outcome.status === "reversed" || outcome.status === "reconciled") {
    await services.documentSync.refreshDocumentProjection({
      documentId: document.documentId as DocumentId,
      threadId,
    });
  }
  return outcome;
});

function parseReverseBody(body: ReverseBody): {
  uri: string;
  direction: "undo" | "redo";
  selection: ReversalSelection;
} {
  if (typeof body.uri !== "string" || body.uri.length === 0) {
    throw createError({ statusCode: 400, message: "uri is required" });
  }
  if (body.direction !== "undo" && body.direction !== "redo") {
    throw createError({ statusCode: 400, message: "direction must be undo or redo" });
  }
  if (body.scope !== "write" && body.scope !== "turn" && body.scope !== "thread") {
    throw createError({ statusCode: 400, message: "scope must be write, turn, or thread" });
  }
  if (body.target !== undefined && typeof body.target !== "string") {
    throw createError({ statusCode: 400, message: "target must be a string" });
  }
  return {
    uri: body.uri,
    direction: body.direction,
    selection: selectionFromScope(body.scope, body.target),
  };
}

function selectionFromScope(
  scope: "write" | "turn" | "thread",
  target: string | undefined,
): ReversalSelection {
  if (scope === "write") {
    if (target === undefined) return { kind: "latest" };
    if (parseWriteHandle(target) === undefined) {
      throw createError({ statusCode: 400, message: "invalid_write" });
    }
    return { kind: "single", to: target };
  }
  if (scope === "turn") {
    if (target === "") throw createError({ statusCode: 400, message: "target must not be empty" });
    return target === undefined ? { kind: "turn" } : { kind: "turn", turnId: target };
  }
  if (target !== undefined) {
    throw createError({ statusCode: 400, message: "thread scope does not accept target" });
  }
  return { kind: "all" };
}

function setReverseStatus(
  event: Parameters<typeof setResponseStatus>[0],
  outcome: WriteOutcome,
): void {
  if (outcome.status === "reversed" || outcome.status === "reconciled") {
    setResponseStatus(event, 202);
    return;
  }
  if (outcome.status === "cant_undo_dependent") {
    throw createError({ statusCode: 409, message: outcome.text });
  }
  if (outcome.status === "invalid_write") {
    throw createError({ statusCode: 400, message: outcome.text });
  }
  if (outcome.status === "document_not_found") {
    throw createError({ statusCode: 404, message: "Document not found" });
  }
  if (outcome.status === "internal_error") {
    throw createError({ statusCode: 500, message: "Edit reversal failed" });
  }
  setResponseStatus(event, 200);
}
