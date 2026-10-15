/** Route core for authenticated live-lineage document reads for one thread turn. */
import type {
  ListTurnLiveLineageResponse,
  TurnLiveLineageDocumentItem,
} from "@meridian/contracts/protocol";
import type { DocumentId, ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import { createError } from "nitro/h3";
import { parseContextUri } from "../domains/context/context/uri.js";
import { requireThreadOwner } from "../domains/threads/index.js";
import type { AppServices } from "./app.js";
import { requireRequestId } from "./request-id.js";

type TurnLiveLineageRouteServices = {
  threads: AppServices["threadRepos"]["threads"];
  fileAccess: Pick<AppServices["fileAccess"], "listAccess">;
  documentSync: AppServices["documentSync"];
};

export function selectTurnLiveLineageRouteServices(app: AppServices): TurnLiveLineageRouteServices {
  return {
    threads: app.threadRepos.threads,
    fileAccess: app.fileAccess,
    documentSync: app.documentSync,
  };
}

export async function handleTurnLiveLineageRequest(
  deps: TurnLiveLineageRouteServices,
  input: { threadId: ThreadId; turnId: TurnId; userId: UserId },
): Promise<ListTurnLiveLineageResponse> {
  const threadId = requireRequestId(input.threadId, "threadId") as ThreadId;
  const turnId = requireRequestId(input.turnId, "turnId") as TurnId;
  await requireThreadOwner({ threads: deps.threads }, threadId, input.userId);
  const documents = await deps.documentSync.listEditedDocumentsForTurn(threadId, turnId);
  const visibleDocuments = await filterAccessibleLiveLineageDocuments(deps, {
    documents,
    userId: input.userId,
  });
  return { documents: visibleDocuments.map(serializeLiveLineageDocument) };
}

/** The lineage's documents the writer can still read (file-access §6). */
async function filterAccessibleLiveLineageDocuments<
  T extends { documentId: string; uri: string; scope: "live" | "draft" },
>(deps: TurnLiveLineageRouteServices, input: { documents: T[]; userId: UserId }): Promise<T[]> {
  const access = await deps.fileAccess.listAccess(
    { accountId: input.userId },
    input.documents.map((document) => document.documentId as DocumentId),
  );
  return input.documents.filter((document) => access.has(document.documentId as DocumentId));
}

function serializeLiveLineageDocument(document: {
  documentId: string;
  uri: string;
  scope: "live" | "draft";
  invisibleWrites?: true;
}): TurnLiveLineageDocumentItem {
  const parsed = parseContextUri(document.uri);
  if (!parsed.ok) {
    throw createError({ statusCode: 500, message: "Live-lineage document URI is invalid" });
  }
  return {
    documentId: document.documentId,
    uri: parsed.value.normalized,
    path: `/${parsed.value.path}`,
    scope: document.scope,
    ...(document.invisibleWrites ? { invisibleWrites: true } : {}),
  };
}
