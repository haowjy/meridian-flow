/** Route core for authenticated live-lineage document reads for one thread turn. */

import { draftOwnerKey } from "@meridian/contracts";
import type {
  ListTurnLiveLineageResponse,
  TurnLiveLineageDocumentItem,
} from "@meridian/contracts/protocol";
import type { ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import { createError } from "nitro/h3";
import {
  type TurnEditedDocument,
  type TurnTreeFolder,
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
  const [visibleDocuments, folders, receipt, workAvailability] = await Promise.all([
    deps.documentSync.listEditedDocumentsForTurn(threadId, turnId).then((documents) =>
      filterAccessibleLiveLineageDocuments(deps, {
        documents,
        userId: input.userId,
      }),
    ),
    deps.documentSync.listFoldersForTurn(threadId, turnId),
    deps.documentSync.getTurnReceiptChip(threadId, turnId),
    getWorkReceiptReversalAvailability(
      {
        blocks: deps.blocks,
        turns: deps.turns,
        works: deps.works,
        threads: deps.threads,
      },
      { threadId, turnId },
    ),
  ]);
  const workReceipt = workAvailability.undo
    ? ({ state: "work-active", control: "undo" } as const)
    : workAvailability.redo
      ? ({ state: "work-reversed", control: "redo" } as const)
      : null;
  return {
    documents: inTreeOrder([
      ...visibleDocuments.map(serializeLiveLineageDocument),
      // The thread's owner has proven the turn is theirs; a folder has no file grant of its own.
      ...folders.map(serializeLiveLineageFolder),
    ]),
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
      // An undone draft create has no draft row left. Its immutable receipt still names the
      // identity, so authorize the row at the same restore seam Redo uses.
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
  const parsed = parseContextUri(folder.at);
  if (!parsed.ok) {
    throw createError({ statusCode: 500, message: "Live-lineage folder URI is invalid" });
  }
  return {
    documentId: folder.nodeId,
    uri: parsed.value.normalized,
    path: `/${parsed.value.path}`,
    folder: true,
    ...(folder.ownerKey
      ? { scope: "draft" as const, owner: folder.ownerKey }
      : { scope: "live" as const }),
    ...(folder.tree ? { tree: folder.tree } : {}),
  };
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
    ...(document.scope === "draft"
      ? { scope: "draft" as const, owner: draftOwnerKey(document.owner) }
      : { scope: "live" as const }),
    ...(document.tree ? { tree: document.tree } : {}),
  };
}

/**
 * The rows as the tree lists them, by where each row says the node is now (a move's
 * destination, a delete's old place): a folder before what it holds, siblings by name.
 */
function inTreeOrder(rows: TurnLiveLineageDocumentItem[]): TurnLiveLineageDocumentItem[] {
  const place = (row: TurnLiveLineageDocumentItem) =>
    (row.tree ? (row.tree.op === "delete" ? row.tree.from : row.tree.to) : row.uri).split("/");
  const places = new Map(rows.map((row) => [row, place(row)]));
  return [...rows].sort((a, b) => {
    const left = places.get(a) ?? [];
    const right = places.get(b) ?? [];
    for (let at = 0; at < Math.min(left.length, right.length); at++) {
      const order = (left[at] ?? "").localeCompare(right[at] ?? "", undefined, { numeric: true });
      if (order) return order;
    }
    return left.length - right.length;
  });
}
