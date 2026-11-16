import { posix } from "node:path";
import type { UserId } from "@meridian/contracts";
import { agentsRootOf } from "@meridian/contracts/agents";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { isInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import type { CollabDomain } from "../../collab/index.js";
import type { ApplyFilesInput, FileChanges } from "../../packages/ports/agent-level-files.js";
import { createProjectContextDocumentStore } from "../context-source-provisioning.js";
import type { TreeListStore } from "../ports/tree-list-store.js";
import { levelFilePaths } from "./level-file-paths.js";
import { treeListOfSource } from "./tree-list-facts.js";

export interface ApplyLevelFilesDeps {
  db: Database;
  documentSync: Pick<CollabDomain, "mergeCodeText" | "readFrozenMarkdown">;
  treeLists: TreeListStore;
}

export function prepareLevelFiles(deps: ApplyLevelFilesDeps, input: ApplyFilesInput) {
  const root = agentsRootOf(input.level);
  const store = createProjectContextDocumentStore(
    deps.db,
    input.projectId ?? "",
    root.scheme,
    input.userId,
  );
  return {
    // Caller takes package Save locks first (in Save order), then this level's list lock,
    // then document mutation locks by id. All writes join that caller's transaction.
    async applyFiles(): Promise<FileChanges> {
      if (!isInDrizzleTransaction())
        throw new Error("applyFiles requires the caller's transaction");
      const sourceId = await store.contextSourceId();
      await deps.treeLists.lock([await treeListOfSource(deps.db, sourceId)]);
      const paths = await levelFilePaths(store);
      const results: FileChanges = {};
      const existing = [];
      for (const [path, change] of Object.entries(input.files)) {
        const found = paths.classify(posix.join(root.path, path));
        if (found.kind !== "source" || (change.base === undefined && change.target === undefined))
          results[path] = { outcome: "skipped", clashes: found.kind === "obstructed" ? 1 : 0 };
        else existing.push({ path, change, id: found.document.id as DocumentId });
      }
      existing.sort((a, b) => a.id.localeCompare(b.id));
      for (const {
        path,
        change: { base, target },
        id,
      } of existing) {
        if (target === undefined) {
          results[path] = { outcome: "skipped", documentId: id, clashes: 0 };
          continue;
        }
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
      }
      return results;
    },
  };
}
