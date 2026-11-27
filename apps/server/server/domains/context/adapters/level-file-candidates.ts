import { type AgentsLevel, agentsRootOf } from "@meridian/contracts/agents";
import { entrySegment, readSegment } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { createProjectContextDocumentStore } from "../context-source-provisioning.js";
import type { ContextDocument } from "../ports/context-document-store.js";
import { LIVE_TREE } from "../tree/tree-view.js";

export interface Candidate {
  document: ContextDocument;
  path: string;
}

export async function candidatesOf(
  db: Database,
  input: { level: AgentsLevel; userId: string; projectId?: string },
): Promise<Map<string, Candidate[]>> {
  const root = agentsRootOf(input.level);
  const byPath = new Map<string, Candidate[]>();
  if (input.level === "project" && !input.projectId) return byPath;
  const store = createProjectContextDocumentStore(
    db,
    input.projectId ?? "",
    root.scheme,
    input.userId,
  );
  const rootFolder =
    root.path === ""
      ? { kind: "found" as const, node: null }
      : await store.resolveFolderAt(LIVE_TREE, root.path);
  if (rootFolder.kind !== "found") return byPath;
  const pending: Array<{ folderId: string | null; prefix: string }> = [
    { folderId: rootFolder.node?.id ?? null, prefix: "" },
  ];
  for (let next = pending.pop(); next; next = pending.pop()) {
    const { folderId, prefix } = next;
    for (const folder of await store.listFolders(LIVE_TREE, folderId)) {
      pending.push({ folderId: folder.id, prefix: `${prefix}${folder.segment}/` });
    }
    for (const document of await store.listDocuments(LIVE_TREE, folderId)) {
      const name = document.extension ? `${document.name}.${document.extension}` : document.name;
      const prose =
        document.fileType === null && document.filetype !== "source" && !document.extension;
      const { suffix } = readSegment(document.segment);
      const path = `${prefix}${entrySegment(prose ? `${name}.md` : name, suffix)}`;
      byPath.set(path, [...(byPath.get(path) ?? []), { document, path }]);
    }
  }
  return byPath;
}
