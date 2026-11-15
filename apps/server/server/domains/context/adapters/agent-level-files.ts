/**
 * One Agents level's package files, in the documents that hold them. A read is one snapshot of
 * the tree and of what each document has admitted, so the files are a state the level was in; it
 * reads the level's folder only, and the text only of documents whose content moved since the
 * last read.
 */

import type { UserId } from "@meridian/contracts";
import { type AgentsLevel, agentsRootOf } from "@meridian/contracts/agents";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { documentYjsHeads } from "@meridian/database/schema";
import { inArray } from "drizzle-orm";
import {
  assertOutsideCommandTransaction,
  currentDrizzleDb,
  runInRootDrizzleReadSnapshot,
} from "../../../shared/drizzle-transaction.js";
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

/** The documents answering to each path of a level, or none when its folder is not there. */
async function candidatesOf(
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
      pending.push({ folderId: folder.id, prefix: `${prefix}${folder.name}/` });
    }
    for (const document of await store.listDocuments(LIVE_TREE, folderId)) {
      const name = document.extension ? `${document.name}.${document.extension}` : document.name;
      const prose =
        document.fileType === null && document.filetype !== "source" && !document.extension;
      const path = `${prefix}${prose ? `${name}.md` : name}`;
      byPath.set(path, [...(byPath.get(path) ?? []), { document, path }]);
    }
  }
  return byPath;
}

export function createAgentLevelFiles(deps: {
  db: Database;
  documentSync: Pick<MarkdownDocumentStore, "readFrozenMarkdown" | "mergeCodeText">;
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

  /** The text the journal holds, which a snapshot reads as of its own cut, never a warm room. */
  async function storedText(document: ContextDocument, version: string | undefined) {
    const cached = texts.get(document.id);
    if (cached && version !== undefined && cached.version === version) return cached.text;
    const text = await deps.documentSync.readFrozenMarkdown(document.id as DocumentId);
    if (version !== undefined) {
      texts.delete(document.id);
      texts.set(document.id, { version, text });
      if (texts.size > CACHED_TEXTS) texts.delete(texts.keys().next().value as string);
    }
    return text;
  }

  return {
    async mergeFiles({ level, userId, projectId, files }) {
      // Only a document the writer still has: a file they deleted stays deleted, and nothing here
      // creates one. Sorted by id so concurrent Undos take the documents' locks in one order.
      const byPath = await candidatesOf(deps.db, { level, userId, projectId });
      const documents = Object.entries(files).flatMap(([path, { base, target }]) => {
        const found = byPath.get(path);
        return found?.length === 1
          ? [{ id: found[0].document.id as DocumentId, base, target }]
          : [];
      });
      for (const { id, base, target } of documents.sort((a, b) => (a.id < b.id ? -1 : 1))) {
        const merged = await deps.documentSync.mergeCodeText({
          documentId: id,
          base,
          target,
          origin: { type: "user", actorUserId: userId as UserId },
        });
        if (!merged.ok) throw new Error(`Cannot restore a package file: ${merged.error.code}`);
      }
    },

    read(input): Promise<LevelFiles> {
      // Inside a command transaction the snapshot below would join it, not isolate the read.
      assertOutsideCommandTransaction("An Agent files read");
      return runInRootDrizzleReadSnapshot(deps.db, async () => {
        const files: Record<string, string> = {};
        const problems: Record<string, string> = {};
        const readable: Candidate[] = [];
        for (const [path, group] of await candidatesOf(deps.db, input)) {
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
          const text = await storedText(document, versions.get(document.id));
          // What the documents hold is untrusted: Mars reads only well-formed UTF-8 text.
          if (text.includes("\0") || Buffer.from(text).toString("utf8") !== text)
            problems[path] = `${path} is not valid UTF-8 text`;
          else files[path] = text;
        }
        return { files, problems };
      });
    },
  };
}
