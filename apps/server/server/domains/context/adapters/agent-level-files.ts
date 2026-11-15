/**
 * Reads one Agents level's package files from the documents that hold them: the level's folder
 * only, and only the documents whose content moved since the last read. A live read shows live;
 * a branch read shows a chat's branch (its tree, and a draft's text over live's).
 */
import { agentsRootOf } from "@meridian/contracts/agents";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { documentDrafts, documentYjsHeads } from "@meridian/database/schema";
import { and, eq, inArray } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { Branches, DraftPeerShadowAccess, MarkdownDocumentStore } from "../../collab/index.js";
import type {
  AgentLevelFiles,
  AgentsBranch,
  LevelFiles,
} from "../../packages/ports/agent-level-files.js";
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
  documentSync: Pick<MarkdownDocumentStore, "readAsMarkdown"> &
    Pick<DraftPeerShadowAccess, "readOwnerMarkdown">;
  branches: Pick<Branches, "viewForOwner">;
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

  /** Which of `ids` the branch holds an active draft of; the rest read as live. */
  async function draftedIn(branchId: string, ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await currentDrizzleDb(deps.db)
      .select({ id: documentDrafts.documentId })
      .from(documentDrafts)
      .where(
        and(
          eq(documentDrafts.branchId, branchId),
          eq(documentDrafts.kind, "work_draft"),
          eq(documentDrafts.status, "active"),
          inArray(documentDrafts.documentId, ids),
        ),
      );
    return new Set(rows.map((row) => row.id));
  }

  async function liveText(document: ContextDocument, version: string | undefined) {
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
    async read({ level, userId, projectId, branch }): Promise<LevelFiles> {
      const root = agentsRootOf(level);
      if (level === "project" && !projectId) return { files: {}, problems: {} };
      const store = createProjectContextDocumentStore(
        deps.db,
        projectId ?? "",
        root.scheme,
        userId,
      );
      const branchView = branch ? await deps.branches.viewForOwner(branch.owner) : LIVE_TREE;
      const view =
        branch?.frozen && branchView.kind === "branch"
          ? { ...branchView, only: branch.frozen.nodes }
          : branchView;
      const rootFolder =
        root.path === ""
          ? { kind: "found" as const, node: null }
          : await store.resolveFolderAt(view, root.path);
      if (rootFolder.kind !== "found") return { files: {}, problems: {} };

      const candidates: Candidate[] = [];
      const pending: Array<{ folderId: string | null; prefix: string }> = [
        { folderId: rootFolder.node?.id ?? null, prefix: "" },
      ];
      for (let next = pending.pop(); next; next = pending.pop()) {
        const { folderId, prefix } = next;
        for (const folder of await store.listFolders(view, folderId)) {
          pending.push({ folderId: folder.id, prefix: `${prefix}${folder.name}/` });
        }
        for (const document of await store.listDocuments(view, folderId)) {
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
      // A branch read shows its drafts' text over live's; a document it holds no draft of is live
      // and shares live's per-version cache. A frozen read has exactly the click's texts.
      const drafted =
        branch && !branch.frozen && branchView.kind === "branch"
          ? await draftedIn(
              branchView.branchId,
              readable.map((candidate) => candidate.document.id),
            )
          : new Set<string>();
      for (const { document, path } of readable) {
        const frozen = branch?.frozen?.texts[document.id];
        let text: string;
        if (frozen !== undefined) text = frozen;
        else if (branch && drafted.has(document.id)) {
          const read = await deps.documentSync.readOwnerMarkdown({
            documentId: document.id as DocumentId,
            owner: branch.owner,
          });
          if (!read.ok) throw new Error(`Cannot read ${document.name}: ${read.error.code}`);
          text = read.value.content;
        } else text = await liveText(document, versions.get(document.id));
        // What the documents hold is untrusted: Mars reads only well-formed UTF-8 text.
        if (text.includes("\0") || Buffer.from(text).toString("utf8") !== text)
          problems[path] = `${path} is not valid UTF-8 text`;
        else files[path] = text;
      }
      return { files, problems };
    },
  };
}
