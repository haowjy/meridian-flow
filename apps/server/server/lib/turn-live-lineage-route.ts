import { type ContextUriScheme, PROJECT_SCOPED_CONTEXT_URI_SCHEMES } from "@meridian/contracts";
import type {
  ListTurnLiveLineageResponse,
  TurnLiveLineageDocumentItem,
} from "@meridian/contracts/protocol";
import type { ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import { createError } from "nitro/h3";
import {
  type TreePlacement,
  type TurnEditedDocument,
  type TurnTreeFolder,
  turnEditDestination,
} from "../domains/collab/domain/turn-live-lineage.js";
import { parseContextUriResult } from "../domains/context/context/uri.js";
import { isFileAccessDenied } from "../domains/file-policy/index.js";
import { requireThreadOwner } from "../domains/threads/index.js";
import type { AppServices } from "./app.js";
import { requireRequestId } from "./request-id.js";
import { getTurnReceiptChip } from "./work-receipt-reversal.js";

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
  const [visibleDocuments, folders, receipt] = await Promise.all([
    deps.documentSync.listEditedDocumentsForTurn(threadId, turnId).then((documents) =>
      filterAccessibleLiveLineageDocuments(deps, {
        documents,
        userId: input.userId,
      }),
    ),
    deps.documentSync.listFoldersForTurn(threadId, turnId),
    getTurnReceiptChip(deps, { threadId, turnId }),
  ]);
  return {
    documents: inTreeOrder<TurnEditedDocument | TurnTreeFolder>([
      ...visibleDocuments,
      ...folders,
    ]).map((row) =>
      "nodeId" in row ? serializeLiveLineageFolder(row) : serializeLiveLineageDocument(row),
    ),
    receipt,
  };
}

async function filterAccessibleLiveLineageDocuments(
  deps: TurnLiveLineageRouteServices,
  input: { documents: TurnEditedDocument[]; userId: UserId },
): Promise<TurnEditedDocument[]> {
  const principal = { accountId: input.userId };
  const readable = await Promise.all(
    input.documents.map(async (document) => {
      let grant =
        document.tree?.op === "delete" || document.removed
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
      if (isFileAccessDenied(grant) && document.tree?.op !== "delete")
        grant = await deps.fileAccess.authorizeAt(
          principal,
          { kind: "restore", documentId: document.documentId },
          turnEditDestination(document),
          "read",
        );
      return !isFileAccessDenied(grant);
    }),
  );
  return input.documents.filter((_, index) => readable[index]);
}

function serializeLiveLineageFolder(folder: TurnTreeFolder): TurnLiveLineageDocumentItem {
  const parsed = parseContextUriResult(folder.at);
  if (!parsed.ok) {
    throw createError({ statusCode: 500, message: "Live-lineage folder URI is invalid" });
  }
  return {
    documentId: folder.nodeId,
    uri: parsed.value.normalized,
    path: `/${parsed.value.path}`,
    folder: true,
    ...(folder.tree ? { tree: folder.tree } : {}),
    ...(folder.draft
      ? { scope: "draft" as const, draft: folder.draft }
      : { scope: "live" as const }),
  };
}

function serializeLiveLineageDocument(document: TurnEditedDocument): TurnLiveLineageDocumentItem {
  const parsed = parseContextUriResult(document.uri);
  if (!parsed.ok) {
    throw createError({ statusCode: 500, message: "Live-lineage document URI is invalid" });
  }
  return {
    documentId: document.documentId,
    uri: parsed.value.normalized,
    path: `/${parsed.value.path}`,
    ...(document.scope === "draft"
      ? { scope: "draft" as const, draft: document.draft }
      : { scope: "live" as const }),
    ...(document.tree ? { tree: document.tree } : {}),
    ...(document.block ? { block: document.block } : {}),
  };
}

const SECTIONS: readonly ContextUriScheme[] = [
  ...PROJECT_SCOPED_CONTEXT_URI_SCHEMES,
  "scratch",
  "uploads",
];

function inTreeOrder<Row extends { placement?: TreePlacement; uri?: string; at?: string }>(
  rows: Row[],
): Row[] {
  const section = (row: Row) => {
    const parsed = parseContextUriResult(row.uri ?? row.at ?? "");
    return parsed.ok ? SECTIONS.indexOf(parsed.value.scheme) : SECTIONS.length;
  };
  return [...rows].sort((a, b) => {
    if (!a.placement || !b.placement) return a.placement ? -1 : b.placement ? 1 : 0;
    if (section(a) !== section(b)) return section(a) - section(b);
    const depth = Math.min(a.placement.length, b.placement.length);
    for (let at = 0; at < depth; at++) {
      const left = a.placement[at] ?? "";
      const right = b.placement[at] ?? "";
      if (left !== right) return left < right ? -1 : 1;
    }
    return a.placement.length - b.placement.length;
  });
}
