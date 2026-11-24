/**
 * Every path the model writes is resolved through the names it was shown (tree-tools.md, "Which
 * tree a stale path is resolved against"): a name that was renamed or moved since reaches the node
 * the model meant, and what the call's path showed is recorded with its result. This is the one place the tools that read or write inside a
 * document do it; the tree commands resolve inside their own command.
 */

import { removerName, splitDocumentFile } from "@meridian/agent-edit/integration";
import { formatParsedContextUri, joinContextUri } from "@meridian/contracts/context-uri";
import type { DocumentRemovalRecord } from "@meridian/contracts/protocol";
import { parseActor } from "../../domains/context/adapters/context-fs/tree-writes.js";
import { parseUnifiedContextUri } from "../../domains/context/index.js";
import {
  addDelta,
  decodeDelta,
  emptyShown,
  encodeDelta,
  type NamesShown,
  printedDelta,
  type ShownDelta,
} from "../../domains/context/tree/names-shown.js";
import { reachPath } from "../../domains/context/tree/tree-commands.js";
import { type ToolHandlerContext, TREE_NAMES_ROOM } from "../../domains/runtime/index.js";
import type { ToolCall, ToolWiringDeps } from "./tool-context.js";

/** What the model has been shown of the tree so far in this conversation. */
export async function shownNamesOf(
  ctx: Pick<ToolHandlerContext, "shownNames">,
): Promise<NamesShown> {
  const shown = emptyShown();
  for (const bytes of (await ctx.shownNames?.()) ?? []) addDelta(shown, decodeDelta(bytes));
  return shown;
}

/** The names a result showed, as the host-only evidence recorded with its block. */
export function namesEvidence(delta: ShownDelta | undefined) {
  if (!delta || (delta.whole.length === 0 && delta.names.length === 0)) return {};
  return { names: { room: TREE_NAMES_ROOM, snapshot: encodeDelta(delta) } };
}

/**
 * What a result showed when it printed the paths of these nodes (one source, `area`): each name
 * along each path as the tree holds it now. Every tool that prints a path records it this way,
 * from the nodes that produced it, so a name means what the model was shown whatever name it
 * typed to get there.
 */
export async function printedNames(
  call: ToolCall,
  area: string,
  ids: readonly string[],
  version?: "draft" | "live",
): Promise<ShownDelta | undefined> {
  if (ids.length === 0) return undefined;
  const read = await call.context.port.readTree(area, {
    ...(version ? { version } : {}),
    read: (scope) => printedDelta(scope.writer.view(scope.view), ids),
  });
  return read.ok ? read.value : undefined;
}

/** The area a path names (`manuscript://`, a Work's, a chat's) and the path below it. */
export function areaOfPath(path: string): { area: string; rest: string } | null {
  const parsed = parseUnifiedContextUri(path);
  if (!parsed.ok) return null;
  const { path: rest } = parsed.value;
  return {
    area: formatParsedContextUri(parsed.value.scheme, "", parsed.value.authority),
    rest: rest && path.trimEnd().endsWith("/") ? `${rest}/` : rest,
  };
}

export type Reached = {
  path: string;
  delta?: ShownDelta;
  /** The node the path reached, when the names shown or the tree hold it. */
  node?: { id: string; kind: "folder" | "document" | "file"; entries: number };
  /**
   * A create's folders that were in Trash and stand again around what it makes, with who deleted
   * them (`folderOf`).
   */
  kept?: string;
  /**
   * The node the path names is not available here (in Trash, purged, or of the other version):
   * the tool answers with `goneMessage` and never looks `path` up again, which could reach
   * another node that holds the name now.
   */
  gone?: Gone;
};

/** Why a path's node is not available, and who deleted it: "you" when it was this chat. */
export type Gone = {
  why: "deleted" | "purged" | "other_version";
  by?: NonNullable<DocumentRemovalRecord["actor"]> | "you";
};

/** What a tool says for a path whose node is not available (`Reached.gone`). */
export function goneMessage(path: string, gone: Gone): string {
  if (gone.why === "deleted") {
    const by = gone.by === "you" ? "you" : removerName(gone.by ?? null);
    return `${path} is in Trash${by ? `: deleted by ${by}` : ""}.`;
  }
  if (gone.why === "purged") return `${path} was emptied from Trash and is gone for good.`;
  return `${path} names something in the other version of the tree, not this one.`;
}

/**
 * The path as it is now for the node the model meant (`#fragment` kept). A path neither the names
 * shown nor the tree hold a node for comes back as written: the tool reports it as it always did.
 * One whose node is not available comes back `gone`. `create` resolves the folder it goes into,
 * not the name it makes, and that folder is never `gone`: one the model was shown that someone
 * deleted since is `node`, and the create goes into it, which brings it back.
 */
export async function reachShown(
  deps: Pick<ToolWiringDeps, "documentRemovals">,
  call: ToolCall,
  ctx: Pick<ToolHandlerContext, "shownNames" | "threadId">,
  path: string,
  options: {
    version?: "draft" | "live";
    folderOf?: boolean;
    /** A write names a node in Trash by the path it was shown: that node is the one it means. */
    deleted?: boolean;
  } = {},
): Promise<Reached> {
  const { filePath, fragment } = splitDocumentFile(path);
  const parts = areaOfPath(filePath);
  if (!parts) return { path };
  const shown = await shownNamesOf(ctx);
  // A create's own name is new: only the folders above it are looked up.
  const slash = parts.rest.lastIndexOf("/");
  const looked = options.folderOf ? parts.rest.slice(0, slash + 1) : parts.rest;
  const leaf = options.folderOf ? parts.rest.slice(slash + 1) : "";
  if (looked === "") return { path };
  const reached = await call.context.port.readTree(parts.area, {
    ...(options.version ? { version: options.version } : {}),
    read: (scope) =>
      reachPath(scope, parts.area, shown, looked, {
        destination: options.folderOf === true,
        ...(options.deleted ? { deleted: true } : {}),
      }),
  });
  if (!reached.ok || reached.value.kind === "unresolved") return { path };
  if (reached.value.kind === "gone") {
    const { why, by } = reached.value;
    if (!by) return { path, gone: { why } };
    const who = parseActor(by);
    if (who?.kind === "agent" && who.chatId === ctx.threadId)
      return { path, gone: { why, by: "you" } };
    const actor = (await deps.documentRemovals.actors([by]))(by);
    return { path, gone: { why, ...(actor ? { by: actor } : {}) } };
  }
  const value = reached.value;
  return {
    path: `${joinContextUri(value.uri, leaf)}${fragment === undefined ? "" : `#${fragment}`}`,
    delta: value.delta,
    node: value.node,
    ...(value.kept ? { kept: value.kept } : {}),
  };
}

/** What a path is, for the result of a tool used on the wrong kind (`kindAt`, issue #1302). */
export function wrongKindMessage(
  uri: string,
  node: NonNullable<Reached["node"]>,
  tool: "read" | "ls",
): string | null {
  if (node.kind === "folder" && tool === "read")
    return `${uri} is a folder with ${node.entries} ${node.entries === 1 ? "entry" : "entries"}.`;
  if (node.kind !== "folder" && tool === "ls")
    return `${uri} is a ${node.kind === "file" ? "file" : "document"}, not a folder.`;
  return null;
}
