import type { BranchId } from "@meridian/contracts";
import type { FileDestination } from "../../domains/file-policy/index.js";
/**
 * The sources of a model's `move` that are in another list (a project's files and the account's
 * `user://` files are two lists): each is copied, with the writer's Copy (`port.copy`), and the
 * original stays. A list is the unit of history, so nothing moves between two. The copy is one
 * command for all of them with one `create` receipt, which holds every copied root and the
 * folders the copy made to reach its destination, so one `undo` or a card's Undo takes it away.
 */

import { createHash } from "node:crypto";
import type { ThreadId, TurnId } from "@meridian/contracts";
import { joinContextUri } from "@meridian/contracts/context-uri";
import { canonicalLeaf, storedFilename } from "@meridian/contracts/protocol";
import { descendantsOf, listRecords } from "@meridian/project-tree";
import type { TreeScope } from "../../domains/context/ports/context-adapter.js";
import type { ContextPort } from "../../domains/context/ports/context-port.js";
import type { ShownDelta } from "../../domains/context/tree/names-shown.js";
import { movesInto, reachPath } from "../../domains/context/tree/tree-commands.js";
import { type FileGrant, runWithEditGrants } from "../../domains/file-policy/index.js";
import type { ToolHandlerContext } from "../../domains/runtime/index.js";
import { fileAccessDeniedError, firstRefusal } from "./file-access.js";
import { areaOfPath, printedNames, shownNamesOf } from "./shown-paths.js";
import {
  contextErrorMessage,
  type ToolCall,
  type ToolWiringDeps,
  writeToolError,
} from "./tool-context.js";

/** The folder part of a path, with its trailing slash. */
const folderPart = (path: string) => path.slice(0, path.lastIndexOf("/") + 1);

/** One id per tool call, so an effect that runs again answers the copy it already made. */
function operationIdOf(ctx: ToolHandlerContext): string {
  const hex = createHash("sha256")
    .update(`${ctx.threadId}:${ctx.turnId ?? ""}:${ctx.toolCallId ?? crypto.randomUUID()}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export type CopiedAcross = {
  copied: number;
  /** Where each copy landed, by the path the model wrote for its original. */
  landed: Array<{ from: string; to: string }>;
  notCopied: string[];
  handle?: string;
  names: ShownDelta | undefined;
};

/**
 * Copies `from` into the folder `path` names, or, for one source that an in-list move would land
 * at `path` (`movesInto`), into the folder that path is in, to be renamed to its last name by
 * `recordCopies`. One source
 * that can't be copied refuses the call; of several, it is listed among those not copied.
 */
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
      // `path` is read as an in-list move reads it; the folder it names is in the other list.
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
          ? { view: { kind: "draft" as const, owner: destination.owner } }
          : {}),
      })),
      destinationUri: joinContextUri(to.area, into),
      ...(destination?.kind === "draft"
        ? {
            destinationBranch: {
              mode: "ensure" as const,
              owner: destination.owner,
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
  // Each source's copy is the entry copied from it; the rest are what stands below those.
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

/** What `copyAcross` made: each source's copied root, and the sources not copied with why. */
export type Copies = {
  area: string;
  roots: Array<{
    source: { from: string; nodeId: string };
    entry: { kind: "file" | "folder"; id: string; path: string };
  }>;
  /** The folders the copy made to reach its destination, outermost first. */
  folders: string[];
  notCopied: string[];
  /** The name one source's path gave it; the copy took its original's, and is renamed to this. */
  name?: string;
};

/**
 * The copy's `create` receipt, in the call's command: what the model's `undo` and a card's Undo
 * take back. The copy itself ran before the command, as the writer's Copy does: it reads its
 * sources outside any transaction.
 */
export async function recordCopies(
  deps: ToolWiringDeps,
  call: ToolCall,
  ctx: ToolHandlerContext,
  port: ContextPort,
  { area, roots, folders, notCopied, name }: Copies,
  drafted: boolean,
): Promise<CopiedAcross> {
  // The copy's records: the folders it made, each root's create and every create below it, and
  // the rename to the name the path gave, which the same Undo takes back first.
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
        return scope.writer.view(scope.view).nodes.get(entry.id)?.displayName;
      });
      return { result: { records, names, draftBranchId: scope.view.draft } };
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
        ...(made.value.draftBranchId
          ? { draftBranchId: made.value.draftBranchId as BranchId }
          : {}),
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

/**
 * Renames a copied root to `name`, as the in-list move renames: a document's name is read as a
 * filename against its own kind. A name that can't be one leaves the copy under its original's.
 */
function renameCopy(scope: TreeScope, node: string, name: string): string | undefined {
  const copied = scope.writer.view(scope.view).nodes.get(node);
  if (!copied) return undefined;
  if (copied.kind === "folder") {
    if (name === copied.displayName) return undefined;
    return scope.writer.rename(scope.view, scope.actor, node, name).id;
  }
  if (canonicalLeaf(name) === canonicalLeaf(copied.displayName)) return undefined;
  const ext = copied.displayName.lastIndexOf(".");
  const parsed = storedFilename(name, {
    extension: ext > 0 ? copied.displayName.slice(ext + 1).toLowerCase() : "",
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
