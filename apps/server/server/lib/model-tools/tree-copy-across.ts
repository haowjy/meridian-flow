import { createHash } from "node:crypto";
import type { DraftId, ThreadId, TurnId } from "@meridian/contracts";
import { joinContextUri } from "@meridian/contracts/context-uri";
import { canonicalLeaf, splitExtension, storedFilename } from "@meridian/contracts/protocol";
import { descendantsOf, listRecords, segmentOf } from "@meridian/project-tree";
import type { TreeScope } from "../../domains/context/ports/context-adapter.js";
import type { ContextPort } from "../../domains/context/ports/context-port.js";
import type { ShownDelta } from "../../domains/context/tree/names-shown.js";
import { movesInto, reachPath } from "../../domains/context/tree/tree-commands.js";
import type { FileDestination } from "../../domains/file-policy/index.js";
import {
  agentDraftOwner,
  type FileGrant,
  runWithEditGrants,
} from "../../domains/file-policy/index.js";
import type { ToolHandlerContext } from "../../domains/runtime/index.js";
import { fileAccessDeniedError, firstRefusal } from "./file-access.js";
import { areaOfPath, printedNames, shownNamesOf } from "./shown-paths.js";
import {
  contextErrorMessage,
  type ToolCall,
  type ToolWiringDeps,
  writeToolError,
} from "./tool-context.js";

const folderPart = (path: string) => path.slice(0, path.lastIndexOf("/") + 1);

function operationIdOf(ctx: ToolHandlerContext): string {
  const hex = createHash("sha256")
    .update(`${ctx.threadId}:${ctx.turnId ?? ""}:${ctx.toolCallId ?? crypto.randomUUID()}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export type CopiedAcross = {
  copied: number;
  landed: Array<{ from: string; to: string }>;
  notCopied: string[];
  handle?: string;
  names: ShownDelta | undefined;
};

export async function copyAcross(
  deps: ToolWiringDeps,
  call: ToolCall,
  ctx: ToolHandlerContext,
  grants: FileGrant<"edit">[],
  command: { from: readonly string[]; path: string; many: boolean },
  destination?: FileDestination,
): Promise<{ refused: unknown } | Copies> {
  const to = areaOfPath(command.path) as NonNullable<ReturnType<typeof areaOfPath>>;
  const shown = await shownNamesOf(ctx);
  const notCopied: string[] = [];
  const sources: Array<{ from: string; uri: string; kind: "file" | "folder"; nodeId: string }> = [];
  for (const from of command.from) {
    const source = areaOfPath(from) as NonNullable<ReturnType<typeof areaOfPath>>;
    const found = await call.context.port.readTree(source.area, {
      read: (scope) => reachPath(scope, source.area, shown, source.rest),
    });
    const reached = found.ok ? found.value : undefined;
    if (reached?.kind !== "node") {
      const why = reached?.kind === "gone" && reached.why === "deleted" ? "in Trash" : "not found";
      if (!command.many)
        return { refused: writeToolError("move", `Nothing copied: ${from} (${why}).`) };
      notCopied.push(`${from} (${why})`);
      continue;
    }
    const folder = reached.node.kind === "folder";
    sources.push({
      from,
      uri: reached.uri,
      kind: folder ? "folder" : "file",
      nodeId: reached.node.id,
    });
  }
  if (sources.length === 0) return { area: to.area, roots: [], folders: [], notCopied };

  const intoFolder =
    command.many ||
    (await (async () => {
      const named = await call.context.port.readTree(to.area, {
        read: (scope) => reachPath(scope, to.area, shown, to.rest, { destination: true }),
      });
      const isFolder =
        named.ok && named.value.kind === "node" && named.value.node.kind === "folder";
      return movesInto(command.path, sources[0]?.kind === "folder", () => isFolder);
    })());
  const at = to.rest.replace(/\/+$/, "");
  const into = intoFolder ? to.rest : folderPart(at);
  const copy = await runWithEditGrants(deps.fileAccess, grants, () =>
    call.context.port.copy({
      operationId: operationIdOf(ctx),
      sources: sources.map((source) => ({
        uri: source.uri,
        expected: { kind: source.kind, nodeId: source.nodeId },
        ...(destination?.kind === "draft"
          ? { view: { kind: "draft" as const, draft: destination.draftId } }
          : {}),
      })),
      destinationUri: joinContextUri(to.area, into),
      ...(destination?.kind === "draft"
        ? {
            destinationDraft: {
              owner: agentDraftOwner(call.principal).owner,
              draftId: destination.draftId,
              threadId: ctx.threadId as ThreadId,
              userId: call.principal.accountId,
            },
          }
        : {}),
    }),
  );
  if (!copy.ok)
    return { refused: fileAccessDeniedError("move", firstRefusal(copy.refusal), command.path) };
  const done = copy.value;
  if (!done.ok) return { refused: writeToolError("move", contextErrorMessage(done.error)) };
  const roots = sources.flatMap((source) => {
    const entry = done.value.entries.find((each) => each.copiedFrom === source.nodeId);
    return entry ? [{ source, entry }] : [];
  });
  const name = intoFolder ? "" : at.slice(into.length);
  return {
    area: to.area,
    roots,
    folders: done.value.folders,
    notCopied,
    ...(name ? { name } : {}),
  };
}

export type Copies = {
  area: string;
  roots: Array<{
    source: { from: string; nodeId: string };
    entry: { kind: "file" | "folder"; id: string; path: string };
  }>;
  folders: string[];
  notCopied: string[];
  name?: string;
};

export async function recordCopies(
  deps: ToolWiringDeps,
  call: ToolCall,
  ctx: ToolHandlerContext,
  port: ContextPort,
  { area, roots, folders, notCopied, name }: Copies,
  drafted: boolean,
): Promise<CopiedAcross> {
  const made = await port.treeCommand(area, {
    drafted,
    make: (scope) => {
      const creates = new Map(
        listRecords(scope.writer.doc).flatMap((record) =>
          record.type === "create" ? [[record.node, record.id] as const] : [],
        ),
      );
      const recordsOf = (nodes: readonly string[]) =>
        nodes.flatMap((node) => {
          const record = creates.get(node);
          return record ? [{ record, node }] : [];
        });
      const before = scope.writer.view(scope.view);
      const records = recordsOf(folders);
      const names = roots.map(({ entry }) => {
        records.push(...recordsOf([entry.id, ...descendantsOf(before, entry.id)]));
        const renamed = name ? renameCopy(scope, entry.id, name) : undefined;
        if (renamed) records.push({ record: renamed, node: entry.id });
        const shown = scope.writer.view(scope.view).nodes.get(entry.id);
        return shown && segmentOf(shown);
      });
      return { result: { records, names, draftId: scope.view.draft } };
    },
  });
  if (!made.ok) throw new Error(`The copy's tree did not write: ${made.error.code}`);

  const landed = roots.map(({ source, entry }, at) => {
    const copiedAt = entry.path.replace(/^\/+|\/+$/g, "");
    const named = made.value.names[at];
    const path = named ? `${folderPart(copiedAt)}${named}` : copiedAt;
    return {
      from: source.from,
      to: joinContextUri(area, `${path}${entry.kind === "folder" ? "/" : ""}`),
      node: entry.id,
    };
  });
  const first = landed[0];
  const recorded = first
    ? await deps.documentSync.treeHistory().recordAgentTreeChange({
        subject: first.node,
        nodes: landed.map(({ node, from, to }) => ({
          nodeId: node,
          beforeAt: null,
          afterAt: to,
          copiedFrom: from,
        })),
        records: made.value.records,
        op: "create",
        ...(made.value.draftId ? { draftId: made.value.draftId as DraftId } : {}),
        threadId: ctx.threadId as ThreadId,
        ...(ctx.turnId ? { turnId: ctx.turnId as TurnId } : {}),
        ...(ctx.responseIdentity ? { responseIdentity: ctx.responseIdentity } : {}),
        ...(ctx.toolCallId ? { toolCallId: ctx.toolCallId } : {}),
        shownAt: first.to,
      })
    : undefined;
  return {
    copied: roots.length,
    landed: landed.map(({ from, to }) => ({ from, to })),
    notCopied,
    ...(recorded ? { handle: recorded.handle } : {}),
    names: await printedNames(
      call,
      area,
      roots.map(({ entry }) => entry.id),
    ),
  };
}

function renameCopy(scope: TreeScope, node: string, name: string): string | undefined {
  const copied = scope.writer.view(scope.view).nodes.get(node);
  if (!copied) return undefined;
  if (copied.kind === "folder") {
    if (name === copied.name) return undefined;
    return scope.writer.rename(scope.view, scope.actor, node, name).id;
  }
  if (canonicalLeaf(name) === canonicalLeaf(copied.name)) return undefined;
  const parsed = storedFilename(name, {
    extension: splitExtension(copied.name).extension.toLowerCase(),
    editable: copied.kind === "document",
    filetype: copied.filetype,
  });
  if (!parsed.ok) return undefined;
  const filetype = parsed.filename.filetype;
  return scope.writer.rename(
    scope.view,
    scope.actor,
    node,
    parsed.name,
    filetype && filetype !== copied.filetype ? filetype : undefined,
  ).id;
}
