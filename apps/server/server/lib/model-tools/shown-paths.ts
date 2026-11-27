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

export async function shownNamesOf(
  ctx: Pick<ToolHandlerContext, "shownNames">,
): Promise<NamesShown> {
  const shown = emptyShown();
  for (const bytes of (await ctx.shownNames?.()) ?? []) addDelta(shown, decodeDelta(bytes));
  return shown;
}

export function namesEvidence(delta: ShownDelta | undefined) {
  if (!delta || (delta.whole.length === 0 && delta.names.length === 0)) return {};
  return { names: { room: TREE_NAMES_ROOM, snapshot: encodeDelta(delta) } };
}

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
  node?: { id: string; kind: "folder" | "document" | "file"; entries: number };
  kept?: string;
  gone?: Gone;
};

export type Gone = {
  why: "deleted" | "purged" | "other_version";
  by?: NonNullable<DocumentRemovalRecord["actor"]> | "you";
};

export function goneMessage(path: string, gone: Gone): string {
  if (gone.why === "deleted") {
    const by = gone.by === "you" ? "you" : removerName(gone.by ?? null);
    return `${path} is in Trash${by ? `: deleted by ${by}` : ""}.`;
  }
  if (gone.why === "purged") return `${path} was emptied from Trash and is gone for good.`;
  return `${path} names something in the other version of the tree, not this one.`;
}

export async function reachShown(
  deps: Pick<ToolWiringDeps, "documentRemovals">,
  call: ToolCall,
  ctx: Pick<ToolHandlerContext, "shownNames" | "threadId">,
  path: string,
  options: {
    version?: "draft" | "live";
    folderOf?: boolean;
    deleted?: boolean;
  } = {},
): Promise<Reached> {
  const { filePath, fragment } = splitDocumentFile(path);
  const parts = areaOfPath(filePath);
  if (!parts) return { path };
  const shown = await shownNamesOf(ctx);
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
