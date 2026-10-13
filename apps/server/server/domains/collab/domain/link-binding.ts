/**
 * Whole-document link binding (contract §6.2): written Markdown becomes a
 * `BoundWrite` here, outside any transaction, and the engine applies it
 * inside one without parsing again.
 *
 * Binding can mint ahead refs, and registering them opens a root transaction
 * that takes namespace keys. A command transaction that already holds those
 * keys would wait on itself forever, invisibly to PostgreSQL. So every
 * whole-document door (ContextFS write and create, uploads, import, writer
 * writes, seeds) binds first and passes the result in;
 * the binder refuses to run inside a transaction so a door that forgot to
 * hoist fails at once.
 *
 * A bound write is desired state: its assigned blocks, applied under the
 * document's lock as agent-edit's ordinary whole-document overwrite, which
 * keeps the items of blocks left as they were and computes the write's IR and
 * authorship there. Like any whole-document save, it replaces what was
 * admitted before it applied. It names the one holder it was bound for, so
 * it is never applied to another; bound fresh, it lands only in an empty
 * document.
 */
import {
  assignLinkRefs,
  type DocumentCoordinator,
  isDocumentNotFoundError,
  toDocHandle,
  type YProsemirrorDocumentModel,
} from "@meridian/agent-edit/integration";
import type { LinkView } from "@meridian/contracts";
import { classifyFiletype, type YjsTrackedSchemaType } from "@meridian/contracts/protocol";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { MarkupCodec, PMNode } from "@meridian/markup";
import { walkLinkOccurrences, writtenAddresses } from "@meridian/markup/links";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import type { Schema } from "prosemirror-model";
import * as Y from "yjs";
import { aheadRegistrations } from "./document-links-port.js";
import {
  type AheadRefRegistrar,
  type DocumentLinkScopes,
  type HolderLinkScope,
  LIVE_VIEW,
} from "./ports/document-link-scope.js";

declare const boundBrand: unique symbol;

/** The one document a bound write may be applied to. */
export type BoundHolder =
  | { kind: "document"; documentId: DocumentId }
  /** The document about to be created at this canonical address; its creator checks the address. */
  | { kind: "new"; uri: string }
  /** Fixed, link-free content (`bindStatic`): seeds any new document. */
  | { kind: "static" };

/** Written content with its links bound; only a `LinkBinder` makes one. */
export interface BoundWrite {
  readonly holder: BoundHolder;
  /**
   * Bound without a current document (seed, import, create, upload): its
   * links were assigned against nothing, so it applies only to an empty
   * document. Otherwise it was bound against the holder's document and
   * overwrites whatever that document holds when it applies.
   */
  readonly fresh: boolean;
  /** The desired blocks: refs assigned, minted ahead refs registered; never reparsed. */
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
  markdown: string;
  /**
   * `current`: bind against the holder's current document, so every link
   * that stays corresponds to itself and keeps its ref, and unchanged content
   * keeps its items (an actor's overwrite). Absent: fresh (seed, import, create).
   */
  against?: "current";
  /** The version the content is written into; whole-document doors write live. */
  view?: LinkView;
}

export interface LinkBinder {
  /**
   * Outside any transaction: open the holder's scope, parse, prepare, assign
   * (fresh, or against the current document) and register minted ahead refs.
   */
  bindMarkdown(input: BindMarkdownInput): Promise<BoundWrite>;
  /**
   * Content fixed in code with no link or source in it (a project's first
   * chapter): parsed without a scope, so it may be bound anywhere. Throws if
   * the content names anything.
   */
  bindStatic(markdown: string, filetype?: string | null): BoundWrite;
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
}

export function createLinkBinder(deps: LinkBinderDeps): LinkBinder {
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

  function boundWrite(input: Omit<BoundWrite, typeof boundBrand>): BoundWrite {
    return input as BoundWrite;
  }

  /** The holder's current nodes, projected from a private clone; null if it has no state yet. */
  async function currentBlocks(documentId: DocumentId): Promise<PMNode[] | null> {
    let state: Uint8Array;
    try {
      state = await deps.coordinator.withDocument(documentId, async (doc) =>
        Y.encodeStateAsUpdate(doc),
      );
    } catch (cause) {
      if (isDocumentNotFoundError(cause)) return null;
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

  async function bind(input: BindMarkdownInput): Promise<BoundWrite> {
    const { holder } = input;
    const view = input.view ?? LIVE_VIEW;
    const documentId = "documentId" in holder ? holder.documentId : null;
    const holderUri = "documentId" in holder ? null : holder.uri;
    const filetype =
      "documentId" in holder ? await deps.resolveFiletype(holder.documentId) : holder.filetype;
    const schemaType = schemaTypeOf(filetype);
    const boundHolder: BoundHolder = documentId
      ? { kind: "document", documentId }
      : { kind: "new", uri: holderUri ?? "" };
    const previous =
      input.against === "current" && documentId ? await currentBlocks(documentId) : null;
    const finish = (blocks: readonly PMNode[], markdown: string) =>
      boundWrite({ holder: boundHolder, fresh: previous === null, blocks, markdown, schemaType });

    const { markdown } = input;
    if (schemaType === "code") return finish([codeBlock(markdown, filetype)], markdown);

    const written = deps.codec.parse(markdown).blocks;
    await deps.links.prepare({
      holders: documentId ? [{ documentId, view }] : [],
      stored: previous ?? [],
      written,
      ...(documentId ? {} : { addresses: writtenAddresses(written, holderUri), views: [view] }),
    });
    const scope: HolderLinkScope = documentId
      ? deps.links.holder({ documentId, view })
      : deps.links.reader({ uri: holderUri, view });
    const assigned = assignLinkRefs({
      old: walkLinkOccurrences(previous ?? []),
      written,
      scope,
      shown: [],
    });
    if (assigned.minted.length > 0) {
      await deps.registrar.register(aheadRegistrations(assigned.minted));
    }
    return finish(assigned.nodes, markdown);
  }

  return {
    async bindMarkdown(input) {
      if (deps.inTransaction()) throw new LinkBindingInsideTransactionError();
      const key =
        "documentId" in input.holder
          ? { documentId: input.holder.documentId }
          : { projectId: input.holder.projectId };
      return deps.links.within(key, () => bind(input));
    },

    bindStatic(markdown, filetype = null) {
      const schemaType = schemaTypeOf(filetype);
      const holder: BoundHolder = { kind: "static" };
      if (schemaType === "code") {
        return boundWrite({
          holder,
          fresh: true,
          blocks: [codeBlock(markdown, filetype)],
          markdown,
          schemaType,
        });
      }
      const blocks = deps.codec.parse(markdown).blocks;
      if (walkLinkOccurrences(blocks).length > 0) {
        throw new Error("Static content names a link or source; bind it with bindMarkdown");
      }
      return boundWrite({ holder, fresh: true, blocks, markdown, schemaType });
    },
  };
}
