/**
 * The model's move between a project's files and the account's `user://` files, and its Undo.
 * They are two lists, so the move is the server's (`port.moveAcrossLists`: one transaction on
 * both, the records `moveBetweenLists` makes). Each path of `from` crosses as itself, a folder with
 * what stands in it, under one receipt that names every node it moved, so Undo finds it from any
 * of them. Taking it back is the same move the other way, by the receipt's records (`reverses`).
 */

import { modelResult } from "@meridian/agent-edit/integration";
import type { ThreadId, TurnId } from "@meridian/contracts";
import { addressScheme, joinContextUri } from "@meridian/contracts/context-uri";
import { canonicalLeaf } from "@meridian/contracts/protocol";
import type { TreeReceipt } from "../../domains/collab/contracts.js";
import { contextPortForThread } from "../../domains/context/index.js";
import type {
  ContextMoveAcrossListsChange,
  ContextPort,
} from "../../domains/context/ports/context-port.js";
import type { ShownDelta } from "../../domains/context/tree/names-shown.js";
import { movesInto, reachPath } from "../../domains/context/tree/tree-commands.js";
import { type FileGrant, runWithEditGrants } from "../../domains/file-policy/index.js";
import type { ToolHandlerContext } from "../../domains/runtime/index.js";
import { fileAccessDeniedError, firstRefusal } from "./file-access.js";
import { areaOfPath, namesEvidence, printedNames, shownNamesOf } from "./shown-paths.js";
import {
  contextErrorMessage,
  type ToolCall,
  type ToolWiringDeps,
  writeToolError,
} from "./tool-context.js";

/** Whether a move from `from` to `to` leaves its list: `user://` is the account's, the rest the project's. */
export const crossesLists = (from: string, to: string) =>
  (addressScheme(from) === "user") !== (addressScheme(to) === "user");

const lastSegment = (path: string) => path.split("/").filter(Boolean).at(-1) ?? "";
/** The folder a path is in, with its trailing slash. */
const folderPart = (path: string) => {
  const own = path.replace(/\/$/, "");
  return own.slice(0, own.lastIndexOf("/") + 1);
};

type Moved = { node: string; uri: string };

type AcrossReceipt = TreeReceipt & { across: { from: string; to: string } };

type Crossing = {
  node: string;
  folder: boolean;
  /** The area it is in now. */
  fromArea: string;
  change: Omit<ContextMoveAcrossListsChange, "origin" | "inTransaction">;
  shownAt: string;
};

/**
 * A move between lists taken back, or done again: the same move the other way, by id, to where
 * the receipt's crossing took the node from (its records say where), under the name it had there.
 * The model's Undo and a card's Undo both take this move, through `port.moveAcrossLists`.
 */
function moveBackOf(receipt: AcrossReceipt): Crossing & { backArea: string } {
  const here = areaOfPath(receipt.across.to) as NonNullable<ReturnType<typeof areaOfPath>>;
  const back = areaOfPath(receipt.across.from) as NonNullable<ReturnType<typeof areaOfPath>>;
  return {
    node: receipt.subject,
    folder: receipt.across.from.endsWith("/"),
    fromArea: here.area,
    change: {
      folderUri: joinContextUri(back.area, folderPart(back.rest)),
      name: lastSegment(back.rest),
      reverses: receipt.records.map((entry) => entry.record),
    },
    shownAt: receipt.across.to,
    backArea: back.area,
  };
}

/** A card's Undo or Redo of a move between lists: the receipt's move back, by the context port. */
export function moveBackAcrossLists(
  port: Pick<ContextPort, "moveAcrossLists">,
  receipt: AcrossReceipt,
  origin: ContextMoveAcrossListsChange["origin"],
) {
  const move = moveBackOf(receipt);
  return port.moveAcrossLists(
    { kind: move.folder ? "folder" : "file", nodeId: move.node },
    move.fromArea,
    { ...move.change, ...(origin ? { origin } : {}) },
  );
}

/** One node across with what stands in it, under the receipt that Undo, Redo and `revert` name. */
async function moveOne(
  deps: ToolWiringDeps,
  call: ToolCall,
  ctx: ToolHandlerContext,
  grants: FileGrant<"edit">[],
  move: Crossing & { reverses?: { kind: "undo" | "redo"; receipt: string } },
) {
  const port = contextPortForThread(deps.contextPorts, call.context.resolution, {
    destination: { kind: "live" },
  });
  const history = deps.documentSync.treeHistory();
  let handle: string | undefined;
  const run = await runWithEditGrants(deps.fileAccess, grants, () =>
    port.moveAcrossLists(
      { kind: move.folder ? "folder" : "file", nodeId: move.node },
      move.fromArea,
      {
        ...move.change,
        origin: {
          type: "agent",
          agentSlug: ctx.agentSlug,
          threadId: ctx.threadId,
          turnId: ctx.turnId,
        },
        inTransaction: async (moved) => {
          const recorded = await history.recordAgentTreeChange({
            subject: move.node,
            nodes: moved.nodes,
            records: moved.records,
            op: "move",
            acrossLists: true,
            threadId: ctx.threadId as ThreadId,
            ...(ctx.turnId ? { turnId: ctx.turnId as TurnId } : {}),
            ...(ctx.responseIdentity ? { responseIdentity: ctx.responseIdentity } : {}),
            ...(ctx.toolCallId ? { toolCallId: ctx.toolCallId } : {}),
            shownAt: move.shownAt,
            ...(move.reverses ? { reverses: move.reverses } : {}),
          });
          handle = recorded.handle;
        },
      },
    ),
  );
  if (!run.ok)
    return { refused: fileAccessDeniedError("move", firstRefusal(run.refusal), move.shownAt) };
  if (!run.value.ok)
    return { refused: writeToolError("move", contextErrorMessage(run.value.error)) };
  const moved = run.value.value;
  return {
    moved: {
      node: move.node,
      uri: moved.nodes[0]?.afterAt ?? moved.destinationUri,
    } satisfies Moved,
    handle,
  };
}

/**
 * The sources of a `move` that leave their list, one by one: each into the folder or name `path`
 * gives in the other, read as a move in one list reads it (`movesInto`). A node in Trash crosses
 * live: a move restores it. One source that can't move refuses the call; of several, it is
 * listed among those not moved.
 */
export async function crossEach(
  deps: ToolWiringDeps,
  call: ToolCall,
  ctx: ToolHandlerContext,
  grants: FileGrant<"edit">[],
  command: { from: readonly string[]; path: string; many: boolean },
): Promise<
  | { refused: unknown }
  | {
      moved: number;
      notMoved: string[];
      handle?: string;
      /** Where the one source landed, when a taken name was numbered. */
      landed?: string;
      names: ShownDelta | undefined;
    }
> {
  const to = areaOfPath(command.path) as NonNullable<ReturnType<typeof areaOfPath>>;
  const shown = await shownNamesOf(ctx);
  const moved: Moved[] = [];
  const notMoved: string[] = [];
  let handle: string | undefined;
  let landed: string | undefined;
  for (const from of command.from) {
    const source = areaOfPath(from) as NonNullable<ReturnType<typeof areaOfPath>>;
    const found = await call.context.port.readTree(source.area, {
      read: (scope) => reachPath(scope, source.area, shown, source.rest, { deleted: true }),
    });
    const reached = found.ok ? found.value : undefined;
    if (reached?.kind !== "node") {
      if (!command.many)
        return { refused: writeToolError("move", `Nothing moved: ${from} (not found).`) };
      notMoved.push(`${from} (not found)`);
      continue;
    }
    const folder = reached.node.kind === "folder";
    const into =
      command.many ||
      // The top of a source is a folder that exists.
      to.rest === "" ||
      (await (async () => {
        const there = await call.context.port.readTree(to.area, {
          read: (scope) => reachPath(scope, to.area, shown, to.rest, { destination: true }),
        });
        return movesInto(
          command.path,
          folder,
          () => there.ok && there.value.kind === "node" && there.value.node.kind === "folder",
        );
      })());
    const leaf = lastSegment(to.rest);
    const sourceName = lastSegment(source.rest);
    const renamed =
      !into && (folder ? leaf !== sourceName : canonicalLeaf(leaf) !== canonicalLeaf(sourceName));
    const result = await moveOne(deps, call, ctx, grants, {
      node: reached.node.id,
      folder,
      fromArea: source.area,
      change: {
        folderUri: joinContextUri(to.area, into ? to.rest : folderPart(to.rest)),
        ...(renamed ? { name: leaf } : {}),
      },
      shownAt: reached.uri,
    });
    if (result.refused) {
      if (!command.many) return { refused: result.refused };
      notMoved.push(`${from} (not moved)`);
      continue;
    }
    moved.push(result.moved);
    handle = result.handle;
    // Where the model would think it is: said back when a taken name was numbered.
    const expected = into ? joinContextUri(to.area, `${to.rest}${sourceName}`) : command.path;
    const plain = (uri: string) => (folder ? uri.replace(/\/$/, "") : canonicalLeaf(uri));
    if (plain(result.moved.uri) !== plain(expected)) landed = result.moved.uri;
  }
  return {
    moved: moved.length,
    notMoved,
    ...(handle ? { handle } : {}),
    ...(landed ? { landed } : {}),
    names: await printedNames(
      call,
      to.area,
      moved.map((entry) => entry.node),
    ),
  };
}

/** Takes a move between lists back (or does an undone one again): the node goes the other way. */
export async function reverseAcrossLists(
  deps: ToolWiringDeps,
  call: ToolCall,
  ctx: ToolHandlerContext,
  grants: FileGrant<"edit">[],
  command: "undo" | "redo" | "revert",
  receipt: AcrossReceipt,
) {
  const { backArea, ...move } = moveBackOf(receipt);
  const result = await moveOne(deps, call, ctx, grants, {
    ...move,
    reverses: { kind: command === "redo" ? "redo" : "undo", receipt: receipt.id },
  });
  if (result.refused)
    return {
      isError: true as const,
      output: modelResult({
        command,
        status: command === "redo" ? "cant_redo_changed" : "cant_undo_changed",
        payload: {
          path: receipt.across.to,
          message: `Can't ${command}: something changed it after that change, or it is gone.`,
        },
      }),
    };
  const names = await printedNames(call, backArea, [result.moved.node]);
  return {
    output: modelResult({
      command,
      status: "reversed",
      payload: {
        path: result.moved.uri,
        ...(result.handle ? { write: { id: result.handle } } : {}),
      },
    }),
    metadata: { treeWrite: true },
    evidence: { shown: [], ...namesEvidence(names) },
  };
}
