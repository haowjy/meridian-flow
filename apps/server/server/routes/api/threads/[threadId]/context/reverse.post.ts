import { parseWriteHandle, type ReversalSelection } from "@meridian/agent-edit";
import type { DocumentId, ThreadId, TurnId } from "@meridian/contracts/runtime";
import {
  createError,
  defineEventHandler,
  getRouterParam,
  readBody,
  setResponseStatus,
} from "nitro/h3";
import {
  aggregateStatus,
  documentReversalResult,
  isSuccessfulReversal,
} from "../../../../../domains/collab/domain/turn-reversal.js";
import type { AppServices } from "../../../../../lib/app.js";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { readThreadContextDocument } from "../../../../../lib/thread-context-route.js";
import {
  handleTurnLiveLineageRequest,
  selectTurnLiveLineageRouteServices,
} from "../../../../../lib/turn-live-lineage-route.js";

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

  if (!input.uri) {
    const liveLineage = await handleTurnLiveLineageRequest(
      selectTurnLiveLineageRouteServices(app),
      {
        threadId,
        turnId: input.turnId,
        userId: user.userId,
      },
    );
    const outcome = await services.documentSync.reverseTurn({
      threadId,
      turnId: input.turnId,
      direction: input.direction,
      actor: { type: "user", userId: user.userId },
      documentIds: [...new Set(liveLineage.documents.map((document) => document.documentId))].map(
        (documentId) => documentId as DocumentId,
      ),
    });
    setResponseStatus(event, 200);
    return outcome;
  }

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

  if (isSuccessfulReversal(outcome)) {
    await services.documentSync.refreshDocumentProjection({
      documentId: document.documentId as DocumentId,
      threadId,
    });
  }
  const documents = [
    await documentReversalResult({
      documentId: document.documentId,
      outcome,
      resolveDocumentUri: async () => input.uri ?? null,
    }),
  ];
  setResponseStatus(event, 200);
  return { status: aggregateStatus(input.direction, documents), documents };
});

type ParsedReverseBody = {
  uri?: string;
  direction: "undo" | "redo";
  scope: "write" | "turn" | "thread";
  selection: ReversalSelection;
  turnId: TurnId;
};

function parseReverseBody(body: ReverseBody): ParsedReverseBody {
  const uri = parseOptionalUri(body.uri);
  if (body.direction !== "undo" && body.direction !== "redo") {
    throw createError({ statusCode: 400, message: "direction must be undo or redo" });
  }
  if (body.scope !== "write" && body.scope !== "turn" && body.scope !== "thread") {
    throw createError({ statusCode: 400, message: "scope must be write, turn, or thread" });
  }
  if (body.target !== undefined && typeof body.target !== "string") {
    throw createError({ statusCode: 400, message: "target must be a string" });
  }
  if (body.scope === "write" && !uri) {
    throw createError({ statusCode: 400, message: "uri required for write scope" });
  }
  if (body.scope === "thread" && !uri) {
    throw createError({ statusCode: 400, message: "uri required for thread scope" });
  }
  if (body.scope === "turn" && !body.target) {
    throw createError({
      statusCode: 400,
      message: "target is required for turn scope",
    });
  }

  return {
    ...(uri ? { uri } : {}),
    direction: body.direction,
    scope: body.scope,
    selection: selectionFromScope(body.scope, body.target),
    turnId: (body.target ?? "") as TurnId,
  };
}

function parseOptionalUri(uri: unknown): string | undefined {
  if (uri === undefined) return undefined;
  if (typeof uri !== "string" || uri.length === 0) {
    throw createError({ statusCode: 400, message: "uri must be a non-empty string" });
  }
  return uri;
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
    return { kind: "turn", turnId: target };
  }
  if (target !== undefined) {
    throw createError({ statusCode: 400, message: "thread scope does not accept target" });
  }
  return { kind: "all" };
}
