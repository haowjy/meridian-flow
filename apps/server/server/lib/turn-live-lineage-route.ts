/** Route core for authenticated live-lineage document reads for one thread turn. */
import type {
  ListTurnLiveLineageResponse,
  TurnLiveLineageDocumentItem,
} from "@meridian/contracts/protocol";
import type { ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import { createError } from "nitro/h3";
import {
  type TurnEditedDocument,
  turnEditDestination,
} from "../domains/collab/domain/turn-live-lineage.js";
import { parseContextUri } from "../domains/context/context/uri.js";
import { isFileAccessDenied } from "../domains/file-policy/index.js";
import { requireThreadOwner } from "../domains/threads/index.js";
import type { AppServices } from "./app.js";
import { requireRequestId } from "./request-id.js";
import { getWorkReceiptReversalAvailability } from "./work-receipt-reversal.js";

type TurnLiveLineageRouteServices = {
  threads: AppServices["threadRepos"]["threads"];
  fileAccess: Pick<AppServices["fileAccess"], "authorize" | "authorizeAt">;
  documentSync: AppServices["documentSync"];
  blocks: AppServices["threadRepos"]["blocks"];
  turns: AppServices["threadRepos"]["turns"];
  works: AppServices["workRepo"];
};

export function selectTurnLiveLineageRouteServices(app: AppServices): TurnLiveLineageRouteServices {
  return {
    threads: app.threadRepos.threads,
    fileAccess: app.fileAccess,
    documentSync: app.documentSync,
    blocks: app.threadRepos.blocks,
    turns: app.threadRepos.turns,
    works: app.workRepo,
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
  const receipt = await deps.documentSync.getTurnReceiptChip(threadId, turnId);
  const workAvailability = await getWorkReceiptReversalAvailability(
    {
      blocks: deps.blocks,
      turns: deps.turns,
      works: deps.works,
      threads: deps.threads,
    },
    { threadId, turnId },
  );
  const workReceipt = workAvailability.undo
    ? ({ state: "work-active", control: "undo" } as const)
    : workAvailability.redo
      ? ({ state: "work-reversed", control: "redo" } as const)
      : null;
  return {
    documents: visibleDocuments.map(serializeLiveLineageDocument),
    receipt: receipt ?? workReceipt,
  };
}

/**
 * The lineage's documents the writer can still read where each edit landed (file-access §6). A
 * document the turn deleted is read where its restore would bring it back, as the card's Undo
 * authorizes it.
 */
async function filterAccessibleLiveLineageDocuments(
  deps: TurnLiveLineageRouteServices,
  input: { documents: TurnEditedDocument[]; userId: UserId },
): Promise<TurnEditedDocument[]> {
  const principal = { accountId: input.userId };
  const readable = await Promise.all(
    input.documents.map(async (document) => {
      const grant =
        document.tree?.op === "delete"
          ? await deps.fileAccess.authorize(
              principal,
              { kind: "restore", documentId: document.documentId },
              "read",
            )
          : await deps.fileAccess.authorizeAt(
              principal,
              { kind: "document", documentId: document.documentId },
              turnEditDestination(document),
              "read",
            );
      return !isFileAccessDenied(grant);
    }),
  );
  return input.documents.filter((_, index) => readable[index]);
}

function serializeLiveLineageDocument(document: TurnEditedDocument): TurnLiveLineageDocumentItem {
  const parsed = parseContextUri(document.uri);
  if (!parsed.ok) {
    throw createError({ statusCode: 500, message: "Live-lineage document URI is invalid" });
  }
  return {
    documentId: document.documentId,
    uri: parsed.value.normalized,
    path: `/${parsed.value.path}`,
    scope: document.scope,
    ...(document.tree ? { tree: document.tree } : {}),
  };
}
