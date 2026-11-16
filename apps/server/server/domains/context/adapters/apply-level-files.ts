import { posix } from "node:path";
import type { UserId } from "@meridian/contracts";
import { agentsRootOf } from "@meridian/contracts/agents";
import { canonicalContextUri } from "@meridian/contracts/context-uri";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { LIVE } from "@meridian/project-tree";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import {
  assertOutsideCommandTransaction,
  currentDrizzleDb,
  isInDrizzleTransaction,
} from "../../../shared/drizzle-transaction.js";
import type { CollabDomain } from "../../collab/index.js";
import type { ApplyFilesInput, FileChanges } from "../../packages/ports/agent-level-files.js";
import { createProjectContextDocumentStore } from "../context-source-provisioning.js";
import { type BoundTree, bindTree } from "../copy/bind-tree.js";
import type { CopyPlan, CopySourceFile, PlannedCopyFile } from "../ports/context-copy.js";
import type { DocumentArrivals } from "../ports/document-arrivals.js";
import type { TreeListStore } from "../ports/tree-list-store.js";
import { type CopyTreeDeps, insertPlannedTrees, treePlan } from "./context-fs/copy-tree.js";
import { createSourceTree } from "./context-fs/tree-writes.js";
import { levelFilePaths } from "./level-file-paths.js";
import { treeListOfSource } from "./tree-list-facts.js";

export interface ApplyLevelFilesDeps {
  db: Database;
  documentSync: Pick<
    CollabDomain,
    | "bindStatic"
    | "bindCopiedBlocks"
    | "encodeSeed"
    | "installSeeds"
    | "createDocumentsAtomically"
    | "mergeCodeText"
    | "readFrozenMarkdown"
    | "refreshDocumentProjection"
  >;
  treeLists: TreeListStore;
  arrivals: Pick<DocumentArrivals, "lockNamespaces" | "settle">;
}

export async function prepareLevelFiles(deps: ApplyLevelFilesDeps, input: ApplyFilesInput) {
  if (input.create) assertOutsideCommandTransaction("Preparing new Agent files");
  const root = agentsRootOf(input.level);
  const store = createProjectContextDocumentStore(
    deps.db,
    input.projectId ?? "",
    root.scheme,
    input.userId,
  );
  const writes = createSourceTree({
    db: deps.db,
    store: deps.treeLists,
    sourceId: () => store.contextSourceId(),
  });
  const holderUri = (path: string) => canonicalContextUri(root.scheme, path);
  const treeDeps: CopyTreeDeps = {
    store,
    writes,
    documentSync: deps.documentSync,
    documentCreation: deps.documentSync,
    arrivals: deps.arrivals,
    actor: `user:${input.userId}`,
    holderUri,
    folderUri: holderUri,
  };
  const schemePath = (path: string) => posix.join(root.path, path);
  const classify = async () => {
    const paths = await levelFilePaths(store);
    return {
      paths,
      files: new Map(
        Object.keys(input.files).map((path) => [path, paths.classify(schemePath(path))]),
      ),
    };
  };
  const plan = ({ paths, files }: Awaited<ReturnType<typeof classify>>): CopyPlan[] => {
    const groups = new Map<string, PlannedCopyFile[]>();
    for (const [path, change] of Object.entries(input.files)) {
      if (!input.create || change.target === undefined || files.get(path)?.kind === "source")
        continue;
      const full = paths.allocate(schemePath(path));
      const segments = full.split("/");
      const filename = segments.pop() as string;
      const dir = segments.join("/");
      const dot = filename.lastIndexOf(".");
      const file: CopySourceFile = {
        kind: "file",
        path,
        uri: holderUri(full),
        documentId: path,
        name: dot > 0 ? filename.slice(0, dot) : filename,
        extension: dot > 0 ? filename.slice(dot + 1) : "",
        filetype: "source",
        fileType: null,
        storageUrl: null,
        mimeType: null,
        sizeBytes: null,
        hasPreview: false,
      };
      groups.set(dir, [
        ...(groups.get(dir) ?? []),
        {
          kind: "file",
          source: file,
          id: crypto.randomUUID(),
          name: file.name,
          extension: file.extension,
          path: full,
          uri: holderUri(full),
        },
      ]);
    }
    return [...groups].map(([dir, roots]) => treePlan(dir ? dir.split("/") : [], roots));
  };
  const bind = async (plans: CopyPlan[]): Promise<BoundTree[]> => {
    const bound: BoundTree[] = [];
    for (const planned of plans) {
      bound.push(
        await bindTree(planned, (file) => ({
          state: deps.documentSync.encodeSeed(
            deps.documentSync.bindCopiedBlocks({
              uri: file.uri,
              filetype: "source",
              sourceHolderUri: null,
              map: planned.map,
              blocks: deps.documentSync.bindStatic(
                input.files[file.source.path].target as string,
                "source",
              ).blocks,
            }),
            { type: "system" },
          ),
        })),
      );
    }
    return bound;
  };
  let planned = input.create ? await bind(plan(await classify())) : [];
  return {
    // Caller takes package Save locks first (in Save order), then this level's list lock,
    // then document mutation locks by id. All writes join that caller's transaction.
    async applyFiles(): Promise<FileChanges> {
      if (!isInDrizzleTransaction())
        throw new Error("applyFiles requires the caller's transaction");
      const sourceId = await store.contextSourceId();
      await deps.treeLists.lock([await treeListOfSource(deps.db, sourceId)]);
      const current = await classify();
      const results: FileChanges = {};
      if (input.create) {
        const next = plan(current);
        const signature = (trees: CopyPlan[]) =>
          trees.flatMap((plan) => plan.documents.map((file) => [file.source.path, file.path]));
        if (
          JSON.stringify(signature(next)) !==
          JSON.stringify(signature(planned.map(({ plan }) => plan)))
        )
          planned = await bind(next);
      }
      if (planned.length > 0) {
        let inserted = await insertPlannedTrees(treeDeps, planned);
        if (inserted.ok && inserted.value.kind === "replan") {
          planned = await bind(plan(await classify()));
          inserted = await insertPlannedTrees(treeDeps, planned);
        }
        if (!inserted.ok || inserted.value.kind !== "copied")
          throw new Error("Agent file creation plan did not hold");
        for (const entry of inserted.value.entries) {
          if (entry.kind === "file")
            results[entry.copiedFrom] = {
              ...(entry.path === schemePath(entry.copiedFrom)
                ? { outcome: "created" as const, clashes: 0 }
                : {
                    outcome: "landed-elsewhere" as const,
                    path: entry.copiedFrom,
                    actualPath: posix.relative(root.path || ".", entry.path),
                    clashes: 1,
                  }),
              documentId: entry.id,
              text: input.files[entry.copiedFrom]?.target,
            };
        }
      }
      const existing = Object.entries(input.files)
        .flatMap(([path, change]) => {
          if (results[path]) return [];
          const found = current.files.get(path);
          if (
            found?.kind !== "source" ||
            (change.base === undefined && change.target === undefined)
          ) {
            results[path] = { outcome: "skipped", clashes: found?.kind === "obstructed" ? 1 : 0 };
            return [];
          }
          const document = found.document;
          return [{ path, change, id: document.id as DocumentId }];
        })
        .sort((a, b) => a.id.localeCompare(b.id));
      const deleted: string[] = [];
      for (const {
        path,
        change: { base, target },
        id,
      } of existing) {
        if (target !== undefined) {
          const merged = await deps.documentSync.mergeCodeText({
            documentId: id,
            base: base ?? "",
            target,
            origin: { type: "user", actorUserId: input.userId as UserId },
          });
          if (!merged.ok) throw new Error(`Cannot merge a package file: ${merged.error.code}`);
          results[path] = {
            text: merged.value.text,
            clashes: merged.value.clashes,
            documentId: id,
            outcome: merged.value.changed ? "merged" : "unchanged",
          };
        } else if (input.delete) {
          await lockDocumentMutation(currentDrizzleDb(deps.db), id);
          const live = await deps.documentSync.readFrozenMarkdown(id);
          if (live === base) {
            deleted.push(id);
            results[path] = { outcome: "deleted", documentId: id, clashes: 0 };
          } else results[path] = { outcome: "unchanged", documentId: id, text: live, clashes: 1 };
        } else results[path] = { outcome: "skipped", documentId: id, clashes: 0 };
      }
      if (deleted.length > 0)
        await writes.run(
          { view: LIVE, actor: `user:${input.userId}` },
          ({ writer, view, actor }) => {
            for (const id of deleted) writer.delete(view, actor, id);
            return { result: undefined };
          },
        );
      return results;
    },
  };
}
