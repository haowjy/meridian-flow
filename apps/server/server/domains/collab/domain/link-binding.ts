/**
 * Whole-document link binding (contract §6.2): written Markdown becomes
 * `BoundContent` here, outside any transaction, and the engine applies it
 * inside one without parsing again.
 *
 * Binding can mint ahead refs, and registering them opens a root transaction
 * that takes namespace keys. A command transaction that already holds those
 * keys would wait on itself forever, invisibly to PostgreSQL. So every
 * whole-document door (ContextFS write, edit and create, import, writer
 * writes, host append, seeds) binds first and passes the result in; the
 * binder refuses to run inside a transaction so a door that forgot to hoist
 * fails at once.
 */
import {
  type AheadMint,
  assignLinkRefs,
  type DocumentCoordinator,
  isDocumentNotFoundError,
  type ShownLink,
  toDocHandle,
  writtenAddresses,
  type YProsemirrorDocumentModel,
} from "@meridian/agent-edit/integration";
import { type LinkView, parseLinkRef } from "@meridian/contracts";
import { classifyFiletype, type YjsTrackedSchemaType } from "@meridian/contracts/protocol";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import { type MarkupCodec, type PMNode, walkLinkOccurrences } from "@meridian/markup";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import type { Schema } from "prosemirror-model";
import * as Y from "yjs";
import {
  type AheadRefRegistrar,
  type DocumentLinkScopes,
  type HolderLinkScope,
  LIVE_VIEW,
} from "./ports/document-link-scope.js";

declare const boundBrand: unique symbol;

/** Written content with its links bound; only a `LinkBinder` makes one. */
export interface BoundContent {
  readonly blocks: readonly PMNode[];
  /** Source Markdown, for provenance and diagnostics only; never reparsed. */
  readonly markdown: string;
  /** Code files bind to one code block; the engine refuses content of the other shape. */
  readonly schemaType: YjsTrackedSchemaType;
  readonly [boundBrand]: true;
}

/** The document the content is for: one that exists, or one about to be created. */
export type BindHolder =
  | { documentId: DocumentId }
  | {
      /** Canonical address it will have; written relative links resolve against it. */
      uri: string;
      projectId: string;
      filetype: string | null;
    };

export interface BindMarkdownInput {
  holder: BindHolder;
  /** The new content, or (host append) a function of the holder's current Markdown. */
  markdown: string | ((current: string) => string);
  /**
   * `current`: bind against the holder's current document, so every link that
   * stays corresponds to itself and keeps its ref (overwrite, append).
   * Absent: fresh (seed, import, create), pass 3 only.
   */
  against?: "current";
  /** An agent write's thread: the binder loads the links that thread was shown. */
  threadId?: ThreadId;
  /** The version the content is written into; whole-document doors write live. */
  view?: LinkView;
}

export interface LinkBinder {
  /**
   * Outside any transaction: open the holder's scope, parse, prepare, assign
   * (fresh, or against the current document), register minted ahead refs.
   */
  bindMarkdown(input: BindMarkdownInput): Promise<BoundContent>;
  /**
   * Content fixed in code with no link or source in it (a project's first
   * chapter): parsed without a scope, so it may be bound anywhere. Throws if
   * the content names anything.
   */
  bindStatic(markdown: string, filetype?: string | null): BoundContent;
}

export class LinkBindingInsideTransactionError extends Error {
  constructor() {
    super("Link binding must run before the command transaction opens (contract §6.2)");
    this.name = "LinkBindingInsideTransactionError";
  }
}

export interface LinkBinderDeps {
  codec: MarkupCodec;
  schema: Schema;
  model: YProsemirrorDocumentModel;
  coordinator: Pick<DocumentCoordinator, "withDocument">;
  links: DocumentLinkScopes;
  registrar: AheadRefRegistrar;
  resolveFiletype(documentId: DocumentId): Promise<string | null>;
  inTransaction(): boolean;
  /** Showings for an agent write's thread (production: the runtime shown-link store). */
  shownLinks?(threadId: ThreadId, documentId: DocumentId): Promise<readonly ShownLink[]>;
}

export function createLinkBinder(deps: LinkBinderDeps): LinkBinder {
  function brand(content: Omit<BoundContent, typeof boundBrand>): BoundContent {
    return content as BoundContent;
  }

  function schemaTypeOf(filetype: string | null): YjsTrackedSchemaType {
    const classification = classifyFiletype(filetype);
    if (classification.kind === "tracked") return classification.schemaType;
    if (classification.kind === "unknown") return "document";
    throw new Error(`Cannot bind ${classification.kind} content as a tracked document`);
  }

  function codeBlock(text: string, filetype: string | null): PMNode {
    return deps.schema.nodes.code_block.create(
      { language: filetype },
      text.length > 0 ? deps.schema.text(text) : undefined,
    );
  }

  /** The holder's current nodes, projected from a private clone; empty if it has no state yet. */
  async function currentBlocks(documentId: DocumentId): Promise<PMNode[]> {
    let state: Uint8Array;
    try {
      state = await deps.coordinator.withDocument(documentId, async (doc) =>
        Y.encodeStateAsUpdate(doc),
      );
    } catch (cause) {
      if (isDocumentNotFoundError(cause)) return [];
      throw cause;
    }
    const clone = createCollabYDoc({ gc: false });
    try {
      Y.applyUpdate(clone, state);
      return [...deps.model.projectBlocks(toDocHandle(clone))];
    } finally {
      clone.destroy();
    }
  }

  async function bind(input: BindMarkdownInput): Promise<BoundContent> {
    const { holder } = input;
    const view = input.view ?? LIVE_VIEW;
    const documentId = "documentId" in holder ? holder.documentId : null;
    const holderUri = "documentId" in holder ? null : holder.uri;
    const filetype =
      "documentId" in holder ? await deps.resolveFiletype(holder.documentId) : holder.filetype;
    const schemaType = schemaTypeOf(filetype);
    const previous =
      input.against === "current" && documentId ? await currentBlocks(documentId) : [];

    if (schemaType === "code") {
      const current = previous[0]?.textContent ?? "";
      const markdown =
        typeof input.markdown === "string" ? input.markdown : input.markdown(current);
      return brand({ blocks: [codeBlock(markdown, filetype)], markdown, schemaType });
    }

    const shown =
      input.threadId && documentId
        ? ((await deps.shownLinks?.(input.threadId, documentId)) ?? [])
        : [];
    const prepare = async (written: readonly PMNode[]) => {
      await deps.links.prepare({
        holders: documentId ? [{ documentId, view }] : [],
        nodes: previous,
        written,
        ...(documentId ? {} : { addresses: writtenAddresses(written, holderUri), views: [view] }),
        refs: shown.map((showing) => showing.ref),
      });
    };
    const scopeFor = (): HolderLinkScope =>
      documentId
        ? deps.links.holder({ documentId, view })
        : deps.links.reader({ uri: holderUri, view });

    let markdown: string;
    if (typeof input.markdown === "string") {
      markdown = input.markdown;
    } else {
      // Append spells the current document the way any reader without a thread sees it, so
      // every old link's spelling corresponds to itself below.
      await prepare([]);
      markdown = input.markdown(
        previous.length > 0 ? deps.codec.serialize(previous, scopeFor()) : "",
      );
    }
    const written = deps.codec.parse(markdown).blocks;
    await prepare(written);
    const scope = scopeFor();
    const assigned = assignLinkRefs({
      old: walkLinkOccurrences(previous),
      written,
      scope,
      holderDocumentId: documentId ?? "",
      shown,
    });
    await register(assigned.minted, scope);
    return brand({ blocks: assigned.nodes, markdown, schemaType });
  }

  async function register(minted: readonly AheadMint[], scope: HolderLinkScope): Promise<void> {
    if (minted.length === 0) return;
    await deps.registrar.register(
      minted.map((mint) => {
        const parsed = parseLinkRef(mint.ref);
        if (parsed?.kind !== "ahead") throw new RangeError(`Not an ahead ref: ${mint.ref}`);
        return {
          aheadId: parsed.aheadId,
          holderProjectId: scope.holder.projectId,
          address: mint.address,
        };
      }),
    );
  }

  return {
    async bindMarkdown(input) {
      if (deps.inTransaction()) throw new LinkBindingInsideTransactionError();
      // An agent write reads as its thread: that thread's account decides readability.
      const viewer = input.threadId ? { viewer: { threadId: input.threadId } } : {};
      const key =
        "documentId" in input.holder
          ? { documentId: input.holder.documentId, ...viewer }
          : { projectId: input.holder.projectId, ...viewer };
      return deps.links.within(key, () => bind(input));
    },

    bindStatic(markdown, filetype = null) {
      const schemaType = schemaTypeOf(filetype);
      if (schemaType === "code") {
        return brand({ blocks: [codeBlock(markdown, filetype)], markdown, schemaType });
      }
      const blocks = deps.codec.parse(markdown).blocks;
      if (walkLinkOccurrences(blocks).length > 0) {
        throw new Error("Static content names a link or source; bind it with bindMarkdown");
      }
      return brand({ blocks, markdown, schemaType });
    },
  };
}
