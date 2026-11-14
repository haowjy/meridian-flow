/**
 * The model's move between a project's files and the account's `user://` files, and its Undo.
 * They are two lists, so the move is the server's (`port.moveAcrossLists`: one transaction on
 * both, the pair of records `moveBetweenLists` makes); taking it back is the same move the other
 * way, which finds the node by id and refuses when it is no longer where the move put it. Each
 * document is its own move with its own receipt. Only documents and files cross; a folder stays.
 */
import { modelResult } from "@meridian/agent-edit/integration";
import type { ThreadId, TurnId } from "@meridian/contracts";
import { canonicalLeaf } from "@meridian/contracts/protocol";
import type { TreeReceipt } from "../../domains/collab/contracts.js";
import { contextPortForThread } from "../../domains/context/index.js";
import type {
  ContextMoveAcrossListsChange,
  ContextPort,
} from "../../domains/context/ports/context-port.js";
import { reachPath } from "../../domains/context/tree/tree-commands.js";
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
  from.startsWith("user://") !== to.startsWith("user://");

const lastSegment = (path: string) => path.split("/").filter(Boolean).at(-1) ?? "";
/** The folder part of a path, with its trailing slash. */
const folderPart = (path: string) => path.slice(0, path.lastIndexOf("/") + 1);

type Moved = { node: string; uri: string };

type AcrossReceipt = TreeReceipt & { across: { from: string; to: string } };

/**
 * A move between lists taken back, or done again, is the move the other way: the node goes back
 * under the folder and name its receipt recorded, found by id. The model's Undo and a card's
 * Undo both take this move, through `port.moveAcrossLists`.
 */
function moveBackOf(receipt: AcrossReceipt) {
  const here = areaOfPath(receipt.across.to) as NonNullable<ReturnType<typeof areaOfPath>>;
  const back = areaOfPath(receipt.across.from) as NonNullable<ReturnType<typeof areaOfPath>>;
  return {
    node: receipt.subject,
    fromUri: receipt.across.to,
    fromArea: here.area,
    folderUri: `${back.area}${folderPart(back.rest)}`,
    name: lastSegment(back.rest),
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
  return port.moveAcrossLists({ kind: "file", nodeId: move.node }, move.fromArea, {
    folderUri: move.folderUri,
    name: move.name,
    onlyAt: move.fromUri.slice(move.fromArea.length),
    origin,
  });
}

/** One document across, with the receipt that Undo, Redo and `revert` name. */
async function moveOne(
  deps: ToolWiringDeps,
  call: ToolCall,
  ctx: ToolHandlerContext,
  grants: FileGrant<"edit">[],
  move: {
    node: string;
    fromUri: string;
    fromArea: string;
    folderUri: string;
    name?: string;
    shownAt: string;
    reverses?: { kind: "undo" | "redo"; receipt: string };
  },
) {
  const port = contextPortForThread(deps.contextPorts, call.context.resolution, {
    liveWrites: true,
  });
  const history = deps.documentSync.treeHistory();
  let handle: string | undefined;
  const run = await runWithEditGrants(deps.fileAccess, grants, () =>
    port.moveAcrossLists({ kind: "file", nodeId: move.node }, move.fromArea, {
      folderUri: move.folderUri,
      ...(move.name !== undefined ? { name: move.name } : {}),
      onlyAt: move.fromUri.slice(move.fromArea.length),
      origin: {
        type: "agent",
        agentSlug: ctx.agentSlug,
        threadId: ctx.threadId,
        turnId: ctx.turnId,
      },
      inTransaction: async (moved) => {
        const recorded = await history.recordAgentTreeChange({
          subject: move.node,
          nodes: [{ nodeId: move.node, beforeAt: move.fromUri, afterAt: moved.destinationUri }],
          records: [
            { record: moved.records.left, node: move.node },
            { record: moved.records.entered, node: move.node },
          ],
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
    }),
  );
  if (!run.ok)
    return { refused: fileAccessDeniedError("move", firstRefusal(run.refusal), move.shownAt) };
  if (!run.value.ok)
    return { refused: writeToolError("move", contextErrorMessage(run.value.error)) };
  return {
    moved: { node: move.node, uri: run.value.value.destinationUri } satisfies Moved,
    handle,
  };
}

/** The `move` that leaves a list: each of `from` into the folder or name `path` gives, in the other. */
export async function runMoveAcrossLists(
  deps: ToolWiringDeps,
  call: ToolCall,
  ctx: ToolHandlerContext,
  grants: FileGrant<"edit">[],
  command: { from: readonly string[]; path: string; many: boolean },
  /** Runs the moves as the call's command. */
  settle: (effect: () => Promise<unknown>) => Promise<unknown>,
) {
  const to = areaOfPath(command.path) as NonNullable<ReturnType<typeof areaOfPath>>;
  const sources = command.from.map((from) => areaOfPath(from));
  if (command.from.some((from) => from.endsWith("/")))
    return writeToolError(
      "move",
      "A folder can't move between a project's files and the account's files; move its documents.",
    );
  if (sources.some((source) => !source || !crossesLists(source.area, to.area)))
    return writeToolError(
      "move",
      "One move can't both stay in a list and leave it: move them in separate calls.",
    );
  return settle(async () => {
    const shown = await shownNamesOf(ctx);
    const moved: Moved[] = [];
    const notMoved: string[] = [];
    let handle: string | undefined;
    let landed: string | undefined;
    for (const from of command.from) {
      const source = areaOfPath(from) as NonNullable<ReturnType<typeof areaOfPath>>;
      const found = await call.context.port.readTree(source.area, {
        read: (scope) => reachPath(scope, source.area, shown, source.rest, "move"),
      });
      const reached = found.ok ? found.value : undefined;
      if (reached?.kind !== "node" || reached.node.kind === "folder") {
        const why =
          reached?.kind === "refused"
            ? reached.refused.status
            : reached?.kind === "node"
              ? "a folder"
              : "not found";
        if (!command.many) return writeToolError("move", `Nothing moved: ${from} (${why}).`);
        notMoved.push(`${from} (${why})`);
        continue;
      }
      // A path ending in `/` is the folder it goes into, under its own name; else the leaf renames it.
      const intoFolder = command.many || command.path.endsWith("/");
      const leaf = lastSegment(to.rest);
      const renamed =
        !intoFolder && canonicalLeaf(leaf) !== canonicalLeaf(lastSegment(source.rest));
      const folderUri = `${to.area}${intoFolder ? to.rest : folderPart(to.rest)}`;
      const result = await moveOne(deps, call, ctx, grants, {
        node: reached.node.id,
        fromUri: reached.uri,
        fromArea: source.area,
        folderUri,
        ...(renamed ? { name: leaf } : {}),
        shownAt: `${source.area}${source.rest}`,
      });
      if (result.refused) {
        if (!command.many) return result.refused;
        notMoved.push(`${from} (not moved)`);
        continue;
      }
      moved.push(result.moved);
      handle = result.handle;
      const expected = intoFolder
        ? `${folderUri}${canonicalLeaf(lastSegment(source.rest))}`
        : `${to.area}${to.rest}`;
      if (canonicalLeaf(result.moved.uri) !== canonicalLeaf(expected)) landed = result.moved.uri;
    }
    if (moved.length === 0) return writeToolError("move", `Nothing moved: ${notMoved.join("; ")}`);
    const names = await printedNames(
      call,
      to.area,
      moved.map((entry) => entry.node),
    );
    return {
      output: modelResult({
        command: "move",
        status: "success",
        phase: "committed",
        payload: {
          ...(!command.many && landed ? { path: landed } : {}),
          destination: "live" as const,
          ...(handle ? { write: { id: handle } } : {}),
          tree: {
            ...(command.many ? { moved: { made: moved.length, of: command.from.length } } : {}),
            ...(notMoved.length > 0 ? { notMoved } : {}),
          },
        },
      }),
      metadata: { treeWrite: true },
      evidence: { shown: [], ...namesEvidence(names) },
    };
  });
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
