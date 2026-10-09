/**
 * ContextFS's bind-outside, apply-inside layer for whole-document writes
 * (contract §6.2): written Markdown is bound before the command transaction
 * opens, because binding may register ahead refs, which takes namespace keys
 * the command transaction will hold; the transaction then applies the
 * bound write and checks it was bound for what occupies the path now.
 */
import { classifyFiletype, type Filetype, filetypeForPath } from "@meridian/contracts/protocol";
import type { DocumentId } from "@meridian/contracts/runtime";
import { Err, Ok, type Result } from "../../../../shared/result.js";
import type { BoundWrite, MarkdownDocumentStore } from "../../../collab/index.js";
import { LinkBindingInsideTransactionError } from "../../../collab/index.js";
import { splitPath } from "../../context/paths.js";
import type { ResultAwareCommandExecutor } from "../../context/result-aware-command-executor.js";
import type { AdapterFault } from "../../ports/context-adapter.js";
import type { ContextDocument } from "../../ports/context-document-store.js";

export const DEFAULT_EDITABLE_FILETYPE = "markdown";
/** How often a write binds again when its holder changed before it could apply. */
const BIND_ATTEMPTS = 3;

export function trackedFiletypeForPath(path: string): Result<Filetype, AdapterFault> {
  const filetype = filetypeForPath(path);
  if (classifyFiletype(filetype).kind === "tracked") return Ok(filetype);
  return Err(binaryTrackedWriteFault(path));
}

export function binaryTrackedWriteFault(path: string): AdapterFault {
  return {
    code: "invalid_operation",
    message: `Cannot create or write ${path} as a tracked text document; binary content must use the upload flow`,
  };
}

export interface BoundWritesDeps {
  documentSync: Pick<MarkdownDocumentStore, "bindMarkdown">;
  commandExecutor: ResultAwareCommandExecutor<AdapterFault>;
  /** The project a document created here belongs to. */
  projectId: string;
  /** The canonical address a document at `path` has, or will have. */
  holderUri(path: string): string;
  /** The document at `path`, if any, read outside any transaction. */
  findDocument(path: string): Promise<ContextDocument | null>;
}

export class BoundWrites {
  constructor(private readonly deps: BoundWritesDeps) {}

  /**
   * Bind outside the command transaction, apply inside it. The bound
   * write names the holder, generation and state it was bound against; if
   * the path's occupant, its generation or its state changed in between
   * (`stale_target`), bind again against what is there now.
   */
  async command<T>(
    bind: () => Promise<Result<BoundWrite, AdapterFault>>,
    apply: (bound: BoundWrite) => Promise<Result<T, AdapterFault>>,
  ): Promise<Result<T, AdapterFault>> {
    for (let attempt = 1; ; attempt++) {
      const bound = await bind();
      if (!bound.ok) return bound;
      const applied = await this.deps.commandExecutor.run(() => apply(bound.value));
      if (applied.ok || applied.error.code !== "stale_target" || attempt >= BIND_ATTEMPTS) {
        return applied;
      }
    }
  }

  /** Whether `bound` was bound for what occupies its path now (`null`: nothing). */
  boundFor(path: string, bound: BoundWrite, occupant: ContextDocument | null): boolean {
    const { holder } = bound;
    if (holder.kind === "document") return occupant?.id === holder.documentId;
    if (holder.kind === "new") return occupant === null && holder.uri === this.deps.holderUri(path);
    return false;
  }

  /**
   * The tracked document at `path`, read before any command transaction so
   * content can be bound against it; the transaction looks it up again.
   */
  async lookup(path: string): Promise<Result<ContextDocument | null, AdapterFault>> {
    const existing = await this.deps.findDocument(path);
    if (existing && existing.fileType !== null) return Err(binaryTrackedWriteFault(path));
    return Ok(existing);
  }

  /**
   * Bind written Markdown for `existing` (null: a document about to be
   * created at `path`), fresh or `against` its current document.
   */
  async bind(
    path: string,
    existing: ContextDocument | null,
    markdown: string,
    against?: "current",
  ): Promise<Result<BoundWrite, AdapterFault>> {
    const { filename } = splitPath(path);
    if (!filename) return Err({ code: "io_error", message: "Cannot write to source root" });
    const filetype = existing
      ? Ok(existing.filetype ?? DEFAULT_EDITABLE_FILETYPE)
      : trackedFiletypeForPath(filename);
    if (!filetype.ok) return filetype;
    try {
      return Ok(
        await this.deps.documentSync.bindMarkdown({
          holder: existing
            ? { documentId: existing.id as DocumentId }
            : {
                uri: this.deps.holderUri(path),
                projectId: this.deps.projectId,
                filetype: filetype.value,
              },
          markdown,
          ...(existing && against ? { against } : {}),
        }),
      );
    } catch (error) {
      if (error instanceof LinkBindingInsideTransactionError) throw error;
      return Err({
        code: "io_error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
