/** Route core for authenticated live-lineage document reads for one thread turn. */
import type {
  ListTurnLiveLineageResponse,
  TurnLiveLineageDocumentItem,
} from "@meridian/contracts/protocol";
import type { ProjectId, ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import { createError } from "nitro/h3";
import { parseContextUri } from "../domains/context/context/uri.js";
import { requireThreadOwner } from "../domains/threads/index.js";
import type { AppServices } from "./app.js";

type TurnLiveLineageRouteServices = {
  threads: AppServices["threadRepos"]["threads"];
  projects: AppServices["projectRepo"];
  documentAccess: AppServices["documentAccess"];
  uploadDocuments: AppServices["uploadDocuments"];
  documentSync: AppServices["documentSync"];
};

export function selectTurnLiveLineageRouteServices(app: AppServices): TurnLiveLineageRouteServices {
  return {
    threads: app.threadRepos.threads,
    projects: app.projectRepo,
    documentAccess: app.documentAccess,
    uploadDocuments: app.uploadDocuments,
    documentSync: app.documentSync,
  };
}

export async function handleTurnLiveLineageRequest(
  deps: TurnLiveLineageRouteServices,
  input: { threadId: ThreadId; turnId: TurnId; userId: UserId },
): Promise<ListTurnLiveLineageResponse> {
  const thread = await requireThreadOwner(
    { threads: deps.threads, projects: deps.projects },
    input.threadId,
    input.userId,
  );
  const documents = await deps.documentSync.listLiveDocumentsForTurn(input.threadId, input.turnId);
  const visibleDocuments = await filterAccessibleLiveLineageDocuments(deps, {
    documents,
    projectId: thread.projectId,
    threadId: input.threadId,
    userId: input.userId,
  });
  return { documents: visibleDocuments.map(serializeLiveLineageDocument) };
}

async function filterAccessibleLiveLineageDocuments<T extends { documentId: string; uri: string }>(
  deps: TurnLiveLineageRouteServices,
  input: {
    documents: T[];
    projectId: ProjectId;
    threadId: ThreadId;
    userId: UserId;
  },
): Promise<Array<{ documentId: string; uri: string }>> {
  const checks = await Promise.all(
    input.documents.map(async (document): Promise<{ documentId: string; uri: string } | null> => {
      const [hasDocumentAccess, isProjectDocument, threadDocument] = await Promise.all([
        deps.documentAccess.canAccessDocument(input.userId, document.documentId),
        deps.documentAccess.canAccessProjectDocument(
          input.userId,
          document.documentId,
          input.projectId,
        ),
        deps.uploadDocuments.getUpload(input.threadId, document.documentId),
      ]);
      return hasDocumentAccess && isProjectDocument && threadDocument ? document : null;
    }),
  );
  return checks.filter(
    (document): document is { documentId: string; uri: string } => document !== null,
  );
}

function serializeLiveLineageDocument(document: {
  documentId: string;
  uri: string;
}): TurnLiveLineageDocumentItem {
  const parsed = parseContextUri(document.uri);
  if (!parsed.ok) {
    throw createError({ statusCode: 500, message: "Live-lineage document URI is invalid" });
  }
  return {
    documentId: document.documentId,
    uri: parsed.value.canonical,
    path: `/${parsed.value.path}`,
  };
}
