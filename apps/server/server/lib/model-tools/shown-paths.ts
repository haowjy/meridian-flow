/**
 * Every path the model writes is resolved through the names it was shown (tree-tools.md, "Which
 * tree a stale path is resolved against"): a name that was renamed or moved since reaches the node
 * the model meant, a name that now means another node reaches nothing, and what the call's path
 * showed is recorded with its result. This is the one place the tools that read or write inside a
 * document do it; the tree commands resolve inside their own command.
 */
import { modelResult, splitDocumentFile } from "@meridian/agent-edit/integration";
import { contextAreaOf, parseUnifiedContextUri } from "../../domains/context/index.js";
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
import {
  type ResultEvidence,
  type ToolHandlerContext,
  TREE_NAMES_ROOM,
} from "../../domains/runtime/index.js";
import type { ToolCall, WriteToolErrorOutput } from "./tool-context.js";

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
  const uri = path.includes("://") ? path : `manuscript://${path}`;
  if (!parseUnifiedContextUri(uri).ok) return null;
  const area = contextAreaOf(uri);
  return { area, rest: uri.slice(area.length) };
}

export type Reached = {
  path: string;
  delta?: ShownDelta;
  /** The node the path reached, when the names shown or the tree hold it. */
  node?: { id: string; kind: "folder" | "document" | "file"; entries: number };
};

/**
 * The path as it is now for the node the model meant (`#fragment` kept), or a refusal that says
 * why nothing was done. A path neither the names shown nor the tree holds comes back as written:
 * the tool reports it as it always did. `create` resolves the folder it goes into, not the
 * name it makes.
 */
export async function reachShown(
  call: ToolCall,
  ctx: Pick<ToolHandlerContext, "shownNames">,
  command: Parameters<typeof modelResult>[0]["command"] | "ls",
  path: string,
  options: { version?: "draft" | "live"; folderOf?: boolean } = {},
): Promise<Reached | (WriteToolErrorOutput & { evidence?: ResultEvidence })> {
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
    read: (scope) => reachPath(scope, parts.area, shown, looked, command),
  });
  if (!reached.ok || reached.value.kind === "unresolved") return { path };
  const value = reached.value;
  if (value.kind === "refused")
    return {
      isError: true,
      output: modelResult({
        command: command === "ls" ? "unknown" : command,
        status: value.refused.status,
        payload: {
          path: value.refused.path,
          message: value.refused.message,
          ...(value.refused.refusal ? { refusal: value.refused.refusal } : {}),
        },
      }),
      ...(value.refused.status === "path_changed"
        ? { evidence: { shown: [], ...namesEvidence(value.refused.delta) } }
        : {}),
    };
  return {
    path: `${value.uri}${leaf}${fragment === undefined ? "" : `#${fragment}`}`,
    delta: value.delta,
    node: value.node,
  };
}

/** What a path is, for the result of a tool used on the wrong kind (`kindAt`, issue #1302). */
export function wrongKindMessage(
  uri: string,
  node: NonNullable<Reached["node"]>,
  tool: "read" | "ls",
): string | null {
  if (node.kind === "folder" && tool === "read")
    return `${uri} is a folder with ${node.entries} ${node.entries === 1 ? "entry" : "entries"}; use \`ls\` to list it.`;
  if (node.kind !== "folder" && tool === "ls")
    return `${uri} is a ${node.kind === "file" ? "file" : "document"}, not a folder; use \`read\` to read it.`;
  return null;
}
