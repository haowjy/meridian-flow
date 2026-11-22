/**
 * ContextFS's live create (contract §6.3, §6.4): the document's `create` record, its first
 * text and its arrival in one command transaction. The record is made at the call, under
 * the list's lock; the content is then seeded under the new document's own lock, which sorts
 * after the list's. A live create never replaces or joins another document: beside one of its
 * name it makes a twin.
 */
import type { DocumentId } from "@meridian/contracts";
import { renderFilename } from "@meridian/contracts/protocol";
import { LIVE } from "@meridian/project-tree";
import { Err, Ok, type Result } from "../../../../shared/result.js";
import type {
  BoundWrite,
  DocumentCreationAggregate,
  DocumentSeedOrigin,
  MarkdownDocumentStore,
  SyncError,
} from "../../../collab/index.js";
import type { ResultAwareCommandExecutor } from "../../context/result-aware-command-executor.js";
import type { AdapterFault } from "../../ports/context-adapter.js";
import type { ContextScheme, ContextWriteOptions } from "../../ports/context-port.js";
import type { DocumentArrivals } from "../../ports/document-arrivals.js";
import type { BoundWrites } from "./bound-writes.js";
import { type CreateTarget, resolveCreateTarget } from "./create-target.js";
import { actorOf, type MadeFolder, type SourceTree } from "./tree-writes.js";

class DocumentCreationFault extends Error {
  constructor(readonly fault: AdapterFault) {
    super("message" in fault ? fault.message : fault.code);
  }
}

export interface LiveCreateDeps {
  tree: SourceTree;
  executor: ResultAwareCommandExecutor<AdapterFault>;
  documentSync: Pick<MarkdownDocumentStore, "seedFromMarkdown">;
  documentCreation: DocumentCreationAggregate;
  boundWrites: BoundWrites;
  arrivals?: Pick<DocumentArrivals, "lockNamespaces" | "settle">;
  scheme: ContextScheme;
  holderUri(path: string): string;
  syncFault(error: SyncError): AdapterFault;
}

export class LiveCreate {
  constructor(private readonly deps: LiveCreateDeps) {}

  /** A live create at `path` with optional content (create routes, imports, a tool's create). */
  async create(
    path: string,
    content: BoundWrite | null,
    options?: ContextWriteOptions,
  ): Promise<Result<{ documentId: string; path: string }, AdapterFault>> {
    const target = resolveCreateTarget(this.deps.scheme, path);
    if (!target.ok) return target;
    const withContent = content !== null && content.markdown.length > 0 ? content : null;
    return this.deps.executor.run(async () => {
      if (withContent && !this.deps.boundWrites.boundFor(path, withContent, null))
        return Err({ code: "stale_target" } as AdapterFault);
      const created = await this.atomically(target.value, withContent, { options });
      return created.ok
        ? Ok({ documentId: created.value.documentId, path: created.value.path })
        : created;
    });
  }

  /**
   * The document's record, content and arrival as one unit, in the caller's command
   * transaction. `content` null leaves the document empty.
   */
  async atomically(
    target: CreateTarget,
    content: BoundWrite | null,
    extra: { options?: ContextWriteOptions; into?: string } = {},
  ): Promise<
    Result<
      {
        documentId: string;
        record: string;
        folders: MadeFolder[];
        markdown: string;
        /** The source-relative path it landed at. */
        path: string;
      },
      AdapterFault
    >
  > {
    const { options } = extra;
    let refusal: AdapterFault | null = null;
    let createdId: string | null = null;
    let createdRecord: string | null = null;
    let createdFolders: MadeFolder[] = [];
    let createdPath = "";
    try {
      const created = await this.deps.documentCreation.createDocumentAtomically({
        persistIdentity: async () => {
          const made = await this.deps.tree.create(
            { view: LIVE, actor: actorOf(options?.origin) },
            {
              dir: target.dir,
              filename: renderFilename(target.name, target.extension),
              kind: "document",
              filetype: target.filetype,
              ...(extra.into ? { into: extra.into } : {}),
              ...(options?.documentId ? { id: options.documentId } : {}),
              ...(options?.metadata ? { metadata: options.metadata } : {}),
            },
          );
          if (!made.ok) {
            refusal = made.error;
            return null;
          }
          // The arrival settles ahead refs under the source's namespace key, taken after the list's.
          await this.deps.arrivals?.lockNamespaces(
            [made.value.id as DocumentId],
            [(await this.deps.tree.sourceId()) as never],
          );
          createdId = made.value.id;
          createdRecord = made.value.record;
          createdFolders = made.value.folders;
          createdPath = made.value.path.join("/");
          return made.value.id as DocumentId;
        },
        initializeContent: async (documentId) => {
          if (!content) return "";
          const provenance = options?.origin;
          const origin: DocumentSeedOrigin =
            provenance?.type === "import"
              ? {
                  type: "import",
                  userId: provenance.userId,
                  source: provenance.source,
                  filename: provenance.filename,
                  sourceId: provenance.sourceId,
                }
              : { type: "system" };
          const seeded = await this.deps.documentSync.seedFromMarkdown(documentId, content, origin);
          if (!seeded.ok) throw new DocumentCreationFault(this.deps.syncFault(seeded.error));
          return content.markdown;
        },
      });
      const refused = refusal as AdapterFault | null;
      if (!created.created) {
        if (!refused) throw new Error("A create made no document and gave no reason");
        return Err(refused);
      }
      if (createdId === null || createdRecord === null)
        throw new Error("A created document reported no identity");
      return Ok({
        documentId: createdId,
        record: createdRecord,
        folders: createdFolders,
        markdown: created.value,
        path: createdPath,
      });
    } catch (error) {
      if (error instanceof DocumentCreationFault) return Err(error.fault);
      throw error;
    }
  }

  /** Arrivals of documents created outside the aggregate (an upload's file). */
  async arrive(documentIds: readonly DocumentId[]): Promise<void> {
    if (!this.deps.arrivals) return;
    await this.deps.arrivals.lockNamespaces(documentIds, [
      (await this.deps.tree.sourceId()) as never,
    ]);
    await this.deps.arrivals.settle(documentIds);
  }
}
