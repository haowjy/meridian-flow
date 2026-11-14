/**
 * Reads one Agents level's package files from the documents that hold them: the level's folder
 * only, live view, and only the documents whose content moved since the last read.
 */
import { agentsRootOf } from "@meridian/contracts/agents";
import type { Database } from "@meridian/database";
import { documentYjsHeads } from "@meridian/database/schema";
import { inArray } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { MarkdownDocumentStore } from "../../collab/index.js";
import type { AgentLevelFiles, LevelFiles } from "../../packages/ports/agent-level-files.js";
import { createProjectContextDocumentStore } from "../context-source-provisioning.js";
import type { ContextDocument } from "../ports/context-document-store.js";
import { LIVE_TREE } from "../tree/tree-view.js";

/** Texts kept between reads; a level is a few dozen small files, so this covers many writers. */
const CACHED_TEXTS = 2000;

interface Candidate {
  document: ContextDocument;
  /** What the document answers to as a package file: a prose `x` answers to `x.md`. */
  path: string;
}

export function createAgentLevelFiles(deps: {
  db: Database;
  documentSync: Pick<MarkdownDocumentStore, "readAsMarkdown">;
}): AgentLevelFiles {
  const texts = new Map<string, { version: string; text: string }>();

  async function versionsOf(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const heads = await currentDrizzleDb(deps.db)
      .select({
        id: documentYjsHeads.documentId,
        authority: documentYjsHeads.authorityId,
        generation: documentYjsHeads.authorityGeneration,
        // Every admitted update moves this; `latestUpdateSeq` waits for the next checkpoint.
        admitted: documentYjsHeads.nextAdmissionSequence,
      })
      .from(documentYjsHeads)
      .where(inArray(documentYjsHeads.documentId, ids));
    return new Map(
      heads.map((head) => [head.id, `${head.authority}:${head.generation}:${head.admitted}`]),
    );
  }

  async function textOf(document: ContextDocument, version: string | undefined): Promise<string> {
    const cached = texts.get(document.id);
    if (cached && version !== undefined && cached.version === version) return cached.text;
    const read = await deps.documentSync.readAsMarkdown(document.id);
    if (!read.ok) throw new Error(`Cannot read ${document.name}: ${read.error.code}`);
    if (version !== undefined) {
      texts.delete(document.id);
      texts.set(document.id, { version, text: read.value });
      if (texts.size > CACHED_TEXTS) texts.delete(texts.keys().next().value as string);
    }
    return read.value;
  }

  return {
    async read({ level, userId, projectId }): Promise<LevelFiles> {
      const root = agentsRootOf(level);
      if (level === "project" && !projectId) return { files: {}, problems: {} };
      const store = createProjectContextDocumentStore(
        deps.db,
        projectId ?? "",
        root.scheme,
        userId,
      );
      const rootFolder =
        root.path === ""
          ? { kind: "found" as const, node: null }
          : await store.resolveFolderAt(LIVE_TREE, root.path);
      if (rootFolder.kind !== "found") return { files: {}, problems: {} };

      const candidates: Candidate[] = [];
      const pending: Array<{ folderId: string | null; prefix: string }> = [
        { folderId: rootFolder.node?.id ?? null, prefix: "" },
      ];
      for (let next = pending.pop(); next; next = pending.pop()) {
        const { folderId, prefix } = next;
        for (const folder of await store.listFolders(LIVE_TREE, folderId)) {
          pending.push({ folderId: folder.id, prefix: `${prefix}${folder.name}/` });
        }
        for (const document of await store.listDocuments(LIVE_TREE, folderId)) {
          const name = document.extension
            ? `${document.name}.${document.extension}`
            : document.name;
          const prose =
            document.fileType === null && document.filetype !== "source" && !document.extension;
          candidates.push({ document, path: `${prefix}${prose ? `${name}.md` : name}` });
        }
      }

      const byPath = new Map<string, Candidate[]>();
      for (const candidate of candidates) {
        byPath.set(candidate.path, [...(byPath.get(candidate.path) ?? []), candidate]);
      }
      const files: Record<string, string> = {};
      const problems: Record<string, string> = {};
      const readable: Candidate[] = [];
      for (const [path, group] of byPath) {
        const [only] = group;
        if (group.length > 1) problems[path] = `${group.length} documents answer to ${path}`;
        else if (only.document.fileType !== null)
          problems[path] = `${path} is a stored file, not text`;
        else if (only.document.filetype !== "source")
          problems[path] = `${path} is a prose document; package files are plain text`;
        else readable.push(only);
      }
      const versions = await versionsOf(readable.map((candidate) => candidate.document.id));
      for (const { document, path } of readable) {
        const text = await textOf(document, versions.get(document.id));
        if (text.includes("\0")) problems[path] = `${path} is not plain text`;
        else files[path] = text;
      }
      return { files, problems };
    },
  };
}
