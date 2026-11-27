import type { DocumentId, DraftId, UserId } from "@meridian/contracts";
import { type ContextSiblingPosition, renderFilename } from "@meridian/contracts/protocol";
import { LIVE } from "@meridian/project-tree";
import { runAfterDrizzleCommit } from "../../../../shared/drizzle-transaction.js";
import { Err, Ok, type Result } from "../../../../shared/result.js";
import {
  type CollabDomain,
  createCopyIdentityMap,
  type DocumentCreationAggregate,
  type EffectiveDocumentReader,
} from "../../../collab/index.js";
import type { AdapterFault } from "../../ports/context-adapter.js";
import type {
  CopiedContent,
  CopyCreatedEntry,
  CopyOutcome,
  CopyPlan,
  CopySourceEntry,
  PlannedCopyFile,
  PlannedCopyNode,
} from "../../ports/context-copy.js";
import type { DocumentArrivals } from "../../ports/document-arrivals.js";
import { NodeIdRefusedError } from "../tree-list-rows.js";
import { type NewNode, type SourceTree, viewOfDraft } from "./tree-writes.js";

export interface CopyTreeDeps {
  writes: SourceTree;
  documentCreation: Pick<DocumentCreationAggregate, "createDocumentsAtomically">;
  documentSync: Pick<CollabDomain, "installSeeds" | "refreshDocumentProjection">;
  arrivals?: Pick<DocumentArrivals, "lockNamespaces" | "settle">;
  actor: string;
  holderUri(path: string): string;
  folderUri(path: string): string;
}

export function planCopyTree(
  deps: CopyTreeDeps,
  input: { dir: readonly string[]; roots: readonly CopySourceEntry[] },
): CopyPlan {
  return treePlan(input.dir, planLevel(deps, [...input.dir], input.roots));
}

export function treePlan(dir: readonly string[], planned: readonly PlannedCopyNode[]): CopyPlan {
  const nodes = flatten(planned);
  const identity = createCopyIdentityMap({
    documents: nodes.flatMap((node) =>
      node.kind === "file"
        ? [
            {
              sourceDocumentId: node.source.documentId,
              sourceUri: node.source.uri,
              documentId: node.id,
              uri: node.uri,
            },
          ]
        : [],
    ),
    folders: nodes.flatMap((node) =>
      node.kind === "folder"
        ? [
            {
              sourceFolderId: node.source.folderId,
              sourceUri: node.source.uri,
              folderId: node.id,
              uri: node.uri,
            },
          ]
        : [],
    ),
  });
  return {
    dir,
    roots: planned,
    map: identity,
    documents: nodes.filter(
      (node): node is PlannedCopyFile => node.kind === "file" && node.source.fileType === null,
    ),
  };
}

export async function insertPlannedTrees(
  deps: CopyTreeDeps,
  inputs: readonly {
    plan: CopyPlan;
    contents: ReadonlyMap<string, CopiedContent>;
    parent?: { folderId: string; createFolders: readonly string[] };
  }[],
  position?: ContextSiblingPosition,
  draft?: {
    draftId: DraftId;
    documentSync: Pick<EffectiveDocumentReader, "writeWorkCreatedContent">;
  },
): Promise<Result<CopyOutcome, AdapterFault>> {
  if (draft) {
    const { draftId } = draft;
    const { plan, contents, parent } = inputs[0];
    const tree = toNewTree(plan.roots, contents);
    if (!tree.ok) return tree;
    try {
      const inserted = await deps.writes.insertTree(
        { view: viewOfDraft(draftId), actor: deps.actor },
        {
          trees: [{ dir: plan.dir, ...(parent ? { parent } : {}), roots: tree.value.roots }],
          ...(position ? { position: position } : {}),
        },
      );
      if (!inserted.ok) return inserted;
      await draft.documentSync.writeWorkCreatedContent(
        [...tree.value.contents].flatMap(([documentId, content]) =>
          content.content
            ? [{ documentId: documentId as DocumentId, content: content.content }]
            : [],
        ),
        { type: "user", actorUserId: deps.actor.slice("user:".length) as UserId },
      );
      return Ok({
        kind: "copied",
        entries: entriesOf(plan.roots, inserted.value.landed),
        folders: inserted.value.folders,
      });
    } catch (error) {
      if (error instanceof NodeIdRefusedError) return Err({ code: "conflict" });
      throw error;
    }
  }
  const trees: {
    dir: readonly string[];
    parent?: { folderId: string; createFolders: readonly string[] };
    roots: readonly NewNode[];
  }[] = [];
  const states = new Map<string, Uint8Array | null>();
  const ids: string[] = [];
  const binaryIds: string[] = [];
  const documents = inputs.flatMap(({ plan }) => [...plan.documents]);
  for (const { plan, contents, parent } of inputs) {
    const tree = toNewTree(plan.roots, contents);
    if (!tree.ok) return tree;
    trees.push({ dir: plan.dir, ...(parent ? { parent } : {}), roots: tree.value.roots });
    for (const [id, content] of tree.value.contents) states.set(id, content.state);
    ids.push(...tree.value.ids);
    binaryIds.push(...tree.value.binaryIds);
  }
  let refusal: AdapterFault | null = null;
  let landed: ReadonlyMap<string, string> = new Map();
  let folders: string[] = [];
  let created: Awaited<ReturnType<DocumentCreationAggregate["createDocumentsAtomically"]>>;
  try {
    created = await deps.documentCreation.createDocumentsAtomically({
      persistIdentities: async () => {
        const inserted = await deps.writes.insertTree(
          { view: LIVE, actor: deps.actor },
          {
            trees,
            ...(position ? { position } : {}),
          },
        );
        if (!inserted.ok) {
          refusal = inserted.error;
          return null;
        }
        landed = inserted.value.landed;
        folders = inserted.value.folders;
        // Arrivals settle ahead refs under the source's namespace key, taken after the list's.
        await deps.arrivals?.lockNamespaces(ids as DocumentId[], [
          (await deps.writes.sourceId()) as never,
        ]);
        return documents.map((document) => document.id as DocumentId);
      },
      initializeContent: (documentIds) =>
        deps.documentSync.installSeeds(
          documentIds.map((documentId) => ({
            documentId,
            state: states.get(documentId) ?? null,
          })),
        ),
    });
  } catch (error) {
    if (error instanceof NodeIdRefusedError) return Err({ code: "conflict" });
    throw error;
  }
  if (refusal) return Err(refusal);
  if (!created.created) return Ok({ kind: "replan" });
  await deps.arrivals?.settle(binaryIds as DocumentId[]);
  runAfterDrizzleCommit(() => {
    const queue = documents.map((document) => document.id as DocumentId);
    const worker = async () => {
      for (let id = queue.shift(); id; id = queue.shift())
        await deps.documentSync.refreshDocumentProjection({ documentId: id });
    };
    void Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
  });
  return Ok({
    kind: "copied",
    entries: inputs.flatMap(({ plan }) => entriesOf(plan.roots, landed)),
    folders,
  });
}

function toNewTree(
  roots: readonly PlannedCopyNode[],
  contents: ReadonlyMap<string, CopiedContent>,
): Result<
  {
    roots: NewNode[];
    contents: Map<string, CopiedContent>;
    ids: string[];
    binaryIds: string[];
  },
  AdapterFault
> {
  const contentsById = new Map<string, CopiedContent>();
  const ids: string[] = [];
  const binaryIds: string[] = [];
  const convert = (node: PlannedCopyNode): Result<NewNode, AdapterFault> => {
    ids.push(node.id);
    if (node.kind === "folder") {
      const children: NewNode[] = [];
      for (const child of node.children) {
        const converted = convert(child);
        if (!converted.ok) return converted;
        children.push(converted.value);
      }
      return Ok({ kind: "folder", id: node.id, filename: node.name, children });
    }
    const { source } = node;
    const filename = renderFilename(node.name, node.extension);
    if (source.fileType !== null) {
      if (!source.storageUrl || !source.mimeType) {
        return Err({
          code: "io_error",
          message: `Copied binary ${source.path} has no stored object or MIME type`,
        });
      }
      binaryIds.push(node.id);
      return Ok({
        kind: "file",
        id: node.id,
        filename,
        blob: {
          storageKey: source.storageUrl,
          mime: source.mimeType,
          size: source.sizeBytes ?? 0,
        },
        hasPreview: source.hasPreview,
        metadata: { copiedFrom: { uri: source.uri, version: "live", revision: null } },
      });
    }
    const content = contents.get(source.documentId);
    if (!content) throw new Error(`No content was bound for ${source.path}`);
    contentsById.set(node.id, content);
    return Ok({
      kind: "document",
      id: node.id,
      filename,
      filetype: source.filetype,
      ...(content.copiedFrom ? { metadata: { copiedFrom: content.copiedFrom } } : {}),
    });
  };
  const converted: NewNode[] = [];
  for (const root of roots) {
    const node = convert(root);
    if (!node.ok) return node;
    converted.push(node.value);
  }
  return Ok({ roots: converted, contents: contentsById, ids, binaryIds });
}

function entriesOf(
  nodes: readonly PlannedCopyNode[],
  landed: ReadonlyMap<string, string>,
): CopyCreatedEntry[] {
  return nodes.flatMap((node): CopyCreatedEntry[] =>
    node.kind === "folder"
      ? [
          {
            kind: "folder",
            id: node.id,
            path: landed.get(node.id) ?? node.path,
            name: node.name,
            copiedFrom: node.source.folderId,
          },
          ...entriesOf(node.children, landed),
        ]
      : [
          {
            kind: "file",
            id: node.id,
            path: landed.get(node.id) ?? node.path,
            name: renderFilename(node.name, node.extension),
            copiedFrom: node.source.documentId,
          },
        ],
  );
}

function flatten(nodes: readonly PlannedCopyNode[]): PlannedCopyNode[] {
  return nodes.flatMap((node) =>
    node.kind === "folder" ? [node, ...flatten(node.children)] : [node],
  );
}

function planLevel(
  deps: CopyTreeDeps,
  dir: readonly string[],
  sources: readonly CopySourceEntry[],
): PlannedCopyNode[] {
  const planned: PlannedCopyNode[] = [];
  for (const source of sources) {
    const extension = source.kind === "folder" ? "" : source.extension;
    const filename = renderFilename(source.name, extension);
    const path = [...dir, filename].join("/");
    if (source.kind === "folder") {
      planned.push({
        kind: "folder",
        source,
        id: source.copyId ?? crypto.randomUUID(),
        name: filename,
        path,
        uri: deps.folderUri(path),
        children: planLevel(deps, [...dir, filename], source.children),
      });
      continue;
    }
    planned.push({
      kind: "file",
      source,
      id: source.copyId ?? crypto.randomUUID(),
      name: source.name,
      extension,
      path,
      uri: deps.holderUri(path),
    });
  }
  return planned;
}
