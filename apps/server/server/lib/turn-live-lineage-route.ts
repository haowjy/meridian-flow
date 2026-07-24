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
import { requireRequestId } from "./request-id.js";

type TurnLiveLineageRouteServices = {
  threads: AppServices["threadRepos"]["threads"];
  projects: AppServices["projectRepo"];
  documentAccess: AppServices["documentAccess"];
  documentSync: AppServices["documentSync"];
};

export function selectTurnLiveLineageRouteServices(app: AppServices): TurnLiveLineageRouteServices {
  return {
    threads: app.threadRepos.threads,
    projects: app.projectRepo,
    documentAccess: app.documentAccess,
    documentSync: app.documentSync,
  };
}

export async function handleTurnLiveLineageRequest(
  deps: TurnLiveLineageRouteServices,
  input: { threadId: ThreadId; turnId: TurnId; userId: UserId },
): Promise<ListTurnLiveLineageResponse> {
  const threadId = requireRequestId(input.threadId, "threadId") as ThreadId;
  const turnId = requireRequestId(input.turnId, "turnId") as TurnId;
  const thread = await requireThreadOwner(
    { threads: deps.threads, projects: deps.projects },
    threadId,
    input.userId,
  );
  const documents = await deps.documentSync.listEditedDocumentsForTurn(threadId, turnId);
  const visibleDocuments = await filterAccessibleLiveLineageDocuments(deps, {
    documents,
    projectId: thread.projectId,
    threadId,
    userId: input.userId,
  });
  return {
    documents: visibleDocuments.map(serializeLiveLineageDocument),
    receipt: await deps.documentSync.getTurnReceiptChip(threadId, turnId),
  };
}

async function filterAccessibleLiveLineageDocuments<
  T extends { documentId: string; uri: string; scope: "live" | "draft" },
>(
  deps: TurnLiveLineageRouteServices,
  input: {
    documents: T[];
    projectId: ProjectId;
    threadId: ThreadId;
    userId: UserId;
  },
): Promise<Array<{ documentId: string; uri: string; scope: "live" | "draft" }>> {
  const checks = await Promise.all(
    input.documents.map(
      async (
        document,
      ): Promise<{ documentId: string; uri: string; scope: "live" | "draft" } | null> => {
        const [hasDocumentAccess, isProjectDocument] = await Promise.all([
          deps.documentAccess.canAccessDocument(input.userId, document.documentId),
          deps.documentAccess.canAccessProjectDocument(
            input.userId,
            document.documentId,
            input.projectId,
          ),
        ]);
        return hasDocumentAccess && isProjectDocument ? document : null;
      },
    ),
  );
  return checks.filter(
    (document): document is { documentId: string; uri: string; scope: "live" | "draft" } =>
      document !== null,
  );
}

function serializeLiveLineageDocument(document: {
  documentId: string;
  uri: string;
  scope: "live" | "draft";
}): TurnLiveLineageDocumentItem {
  const parsed = parseContextUri(document.uri);
  if (!parsed.ok) {
    throw createError({ statusCode: 500, message: "Live-lineage document URI is invalid" });
  }
  return {
    documentId: document.documentId,
    uri: parsed.value.canonical,
    path: `/${parsed.value.path}`,
    scope: document.scope,
  };
}
