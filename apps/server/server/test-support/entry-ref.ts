import type { ContextEntryRef, ContextSiblingPosition } from "@meridian/contracts/protocol";
import { storedFilename } from "@meridian/contracts/protocol";
import { childrenOf, descendantsOf } from "@meridian/project-tree";
import { type ContextPort, contextAreaOf, type WriteProvenance } from "../domains/context/index.js";
import type { TreeScope } from "../domains/context/ports/context-adapter.js";

export async function entryAt(
  port: Pick<ContextPort, "stat" | "list">,
  uri: string,
): Promise<ContextEntryRef> {
  const file = await port.stat(uri);
  if (file.ok && file.value.documentId) return { kind: "file", nodeId: file.value.documentId };
  const trimmed = uri.replace(/\/+$/, "");
  const name = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  const listed = await port.list(trimmed.slice(0, trimmed.length - name.length));
  const folder = listed.ok
    ? listed.value.entries.find(
        (entry) => entry.kind === "directory" && entry.uri.replace(/\/+$/, "") === trimmed,
      )
    : undefined;
  if (!folder?.folderId) throw new Error(`Nothing to move at ${uri}`);
  return { kind: "folder", nodeId: folder.folderId };
}

export function moveInScope(
  scope: TreeScope,
  nodeId: string,
  dir: readonly string[],
  leaf: string | undefined,
  position?: ContextSiblingPosition,
): { arrived: string[] } {
  const { writer, view, actor } = scope;
  let parent = scope.root;
  for (const name of dir) {
    const existing = childrenOf(writer.view(view), parent).find((node) => node.name === name);
    parent = existing?.id ?? writer.create(view, actor, { kind: "folder", name, parent }).node;
  }
  const node = writer.view(view).nodes.get(nodeId);
  if (!node) throw new Error(`No node ${nodeId} to move`);
  if (parent !== node.parent || position)
    writer.moveAll(view, actor, [nodeId], parent, position ?? { kind: "end" });
  if (leaf !== undefined) {
    const dot = node.name.lastIndexOf(".");
    const parsed =
      node.kind === "folder"
        ? null
        : storedFilename(leaf, {
            extension: dot > 0 ? node.name.slice(dot + 1).toLowerCase() : "",
            editable: node.kind === "document",
          });
    if (parsed && !parsed.ok) throw new Error(parsed.message);
    const name = parsed ? parsed.name : leaf;
    if (name !== node.name)
      writer.rename(
        view,
        actor,
        nodeId,
        name,
        parsed?.ok && parsed.filename.filetype && parsed.filename.filetype !== node.filetype
          ? parsed.filename.filetype
          : undefined,
      );
  }
  const after = writer.view(view);
  return {
    arrived: [nodeId, ...descendantsOf(after, nodeId)].filter(
      (id) => after.nodes.get(id)?.kind !== "folder",
    ),
  };
}

type MoveToOptions = {
  expected: ContextEntryRef;
  origin?: WriteProvenance;
  position?: ContextSiblingPosition;
};

export function moveTo(
  port: Pick<ContextPort, "treeCommand">,
  _from: string,
  to: string,
  options: MoveToOptions,
) {
  const area = contextAreaOf(to);
  const names = to.slice(area.length).split("/");
  const leaf = names.pop();
  return port.treeCommand(area, {
    ...(options.origin ? { origin: options.origin } : {}),
    make: (scope) => ({
      result: undefined,
      arrived: moveInScope(
        scope,
        options.expected.nodeId,
        names.filter(Boolean),
        leaf || undefined,
        options.position,
      ).arrived,
    }),
  });
}

export function deleteAt(
  port: Pick<ContextPort, "treeCommand">,
  uri: string,
  options: { expected: ContextEntryRef; origin?: WriteProvenance },
) {
  return port.treeCommand(contextAreaOf(uri), {
    ...(options.origin ? { origin: options.origin } : {}),
    make: (scope) => {
      scope.writer.delete(scope.view, scope.actor, options.expected.nodeId);
      return { result: undefined };
    },
  });
}
