import type { DocumentId } from "@meridian/contracts/runtime";
import { documents } from "@meridian/database/schema";
import { inArray } from "drizzle-orm";
import {
  assertOutsideCommandTransaction,
  currentDrizzleDb,
  runInRootDrizzleReadSnapshot,
} from "../../../shared/drizzle-transaction.js";
import type { DocumentLinkScopes } from "../../collab/index.js";
import type { AgentLevelFiles, LevelFiles } from "../../packages/ports/agent-level-files.js";
import type { ContextDocument } from "../ports/context-document-store.js";
import { type ApplyLevelFilesDeps, prepareLevelFiles } from "./apply-level-files.js";
import { type Candidate, candidatesOf } from "./level-file-candidates.js";

const CACHED_TEXTS = 2000;

export function createAgentLevelFiles(
  deps: ApplyLevelFilesDeps & { links: Pick<DocumentLinkScopes, "within"> },
): AgentLevelFiles {
  const texts = new Map<string, { version: string; text: string }>();

  async function versionsOf(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    // Every save of the document's Live room moves its `content_seq`.
    const rows = await currentDrizzleDb(deps.db)
      .select({ id: documents.id, seq: documents.contentSeq })
      .from(documents)
      .where(inArray(documents.id, ids as DocumentId[]));
    return new Map(rows.map((row) => [row.id, String(row.seq)]));
  }

  async function storedText(document: ContextDocument, version: string | undefined) {
    const cached = texts.get(document.id);
    if (cached && version !== undefined && cached.version === version) return cached.text;
    const read = await deps.documentSync.readAsMarkdown(document.id);
    const text = read.ok ? read.value : "";
    if (version !== undefined) {
      texts.delete(document.id);
      texts.set(document.id, { version, text });
      if (texts.size > CACHED_TEXTS) texts.delete(texts.keys().next().value as string);
    }
    return text;
  }

  return {
    prepareFiles: async (input) => prepareLevelFiles(deps, input),

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
        const readAll = async () => {
          for (const { document, path } of readable) {
            const text = await storedText(document, versions.get(document.id));
            // What the documents hold is untrusted: Mars reads only well-formed UTF-8 text.
            if (text.includes("\0") || Buffer.from(text).toString("utf8") !== text)
              problems[path] = `${path} isn't plain text: it holds a NUL byte or isn't valid UTF-8`;
            else files[path] = text;
          }
        };
        // A home document has no project of its own: its links read in the project asking.
        if (input.projectId)
          await deps.links.within(
            { projectId: input.projectId, viewer: { accountId: input.userId } },
            readAll,
          );
        else await readAll();
        return { files, problems };
      });
    },
  };
}
