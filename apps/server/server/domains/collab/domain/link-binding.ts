/**
 * Whole-document link binding (contract §6.2): written Markdown becomes a
 * `PreparedWrite` here, outside any transaction, and the engine applies it
 * inside one without parsing again.
 *
 * Binding can mint ahead refs, and registering them opens a root transaction
 * that takes namespace keys. A command transaction that already holds those
 * keys would wait on itself forever, invisibly to PostgreSQL. So every
 * whole-document door (ContextFS write and create, uploads, import, writer
 * writes, seeds) prepares first and passes the result in;
 * the binder refuses to run inside a transaction so a door that forgot to
 * hoist fails at once.
 *
 * Because preparing and applying are separated, a prepared write is a Yjs
 * mutation against the base it was bound to, never a desired state: anything
 * admitted in between merges with it instead of being undone. It also names
 * the one holder it was prepared for, so it is never applied to another, and
 * certifies the authority generation its base belonged to, so it is never
 * admitted into another (a restore replaces the generation even when its
 * checkpoint keeps every clock the base had).
 *
 * Against a base, the mutation is agent-edit's whole-document overwrite of it
 * (`lowerOverwrite`), so the write also carries that overwrite's semantic IR
 * and the certified provenance facts it implies, written against the base.
 */
import {
  type AgentEditCodec,
  type AheadMint,
  assignLinkRefs,
  createAgentEditCodecFactory,
  type DocumentCoordinator,
  isDocumentNotFoundError,
  lowerOverwrite,
  type SemanticEditIRV1,
  type SemanticProvenanceWriter,
  toDocHandle,
  writtenAddresses,
  type YProsemirrorDocumentModel,
} from "@meridian/agent-edit/integration";
import { type LinkView, parseLinkRef } from "@meridian/contracts";
import { classifyFiletype, type YjsTrackedSchemaType } from "@meridian/contracts/protocol";
import type { DocumentId } from "@meridian/contracts/runtime";
import { type MarkupCodec, type PMNode, walkLinkOccurrences } from "@meridian/markup";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import type { Schema } from "prosemirror-model";
import * as Y from "yjs";
import { documentAuthority } from "./document-handle.js";
import type { CheckpointAuthority } from "./ports/checkpoint-authority.js";
import {
  type AheadRefRegistrar,
  type DocumentLinkScopes,
  type HolderLinkScope,
  LIVE_VIEW,
} from "./ports/document-link-scope.js";

declare const preparedBrand: unique symbol;

/** The one document a prepared write may be applied to. */
export type PreparedHolder =
  | { kind: "document"; documentId: DocumentId }
  /** The document about to be created at this canonical address; its creator checks the address. */
  | { kind: "new"; uri: string }
  /** Fixed, link-free content (`bindStatic`): seeds any new document. */
  | { kind: "static" };

/**
 * The base a write was prepared against. Two separate checks guard applying
 * it: the authority generation must still be the one the base was read from
 * (the certificate; admission checks it under the document's lock), and the
 * document must hold every clock in `stateVector` (the update's dependency).
 * Neither implies the other: a restore can keep every clock yet replace the
 * generation, and a state vector says nothing of which generation it is in.
 */
export interface PreparedBase {
  readonly authority: Readonly<CheckpointAuthority>;
  readonly stateVector: Uint8Array;
}

/** Written content, bound and turned into a Yjs mutation; only a `LinkBinder` makes one. */
export interface PreparedWrite {
  readonly holder: PreparedHolder;
  /** Null: prepared fresh, from an empty document (seed, import, create, upload). */
  readonly base: PreparedBase | null;
  /** The Yjs update that turns `base` into the bound result. */
  readonly update: Uint8Array;
  /**
   * The overwrite's certified intent, when it changed a base: its IR, and
   * the provenance facts it implies as an update on top of `update`. Only
   * certified (thread and agent) writes admit them; a writer's fresh save
   * applies `update` alone.
   */
  readonly certified: { readonly ir: SemanticEditIRV1; readonly provenance: Uint8Array } | null;
  /** The bound result's blocks, so a writer can load what they name; never reparsed. */
  readonly blocks: readonly PMNode[];
  /** Source Markdown, for provenance and diagnostics only; never reparsed. */
  readonly markdown: string;
  /** Code files bind to one code block; the engine refuses content of the other shape. */
  readonly schemaType: YjsTrackedSchemaType;
  readonly [preparedBrand]: true;
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
   * `current`: prepare against the holder's current document, so every link
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
   * (fresh, or against the current document), register minted ahead refs,
   * and encode the result as an update against the base.
   */
  bindMarkdown(input: BindMarkdownInput): Promise<PreparedWrite>;
  /**
   * Content fixed in code with no link or source in it (a project's first
   * chapter): parsed without a scope, so it may be bound anywhere. Throws if
   * the content names anything.
   */
  bindStatic(markdown: string, filetype?: string | null): PreparedWrite;
}

export class LinkBindingInsideTransactionError extends Error {
  constructor() {
    super("Link binding must run before the command transaction opens (contract §6.2)");
    this.name = "LinkBindingInsideTransactionError";
  }
}

/**
 * Whether `doc` has seen every clock `base` names, so `update`'s dependencies
 * are present. Clock containment only: it is no generation fence (see
 * `sameAuthority`), and it does not prove the base's items are still live.
 */
export function containsBase(doc: Y.Doc, base: PreparedBase | null): boolean {
  if (base === null) return true;
  const have = Y.decodeStateVector(Y.encodeStateVector(doc));
  for (const [client, clock] of Y.decodeStateVector(base.stateVector)) {
    if ((have.get(client) ?? 0) < clock) return false;
  }
  return true;
}

/** Whether a document's authority is the generation a prepared base certified. */
export function sameAuthority(current: Readonly<CheckpointAuthority>, base: PreparedBase): boolean {
  return (
    current.authorityId === base.authority.authorityId &&
    current.generation === base.authority.generation
  );
}

export interface LinkBinderDeps {
  codec: MarkupCodec;
  schema: Schema;
  model: YProsemirrorDocumentModel;
  semanticProvenance: SemanticProvenanceWriter;
  coordinator: Pick<DocumentCoordinator, "withDocument">;
  links: DocumentLinkScopes;
  registrar: AheadRefRegistrar;
  resolveFiletype(documentId: DocumentId): Promise<string | null>;
  inTransaction(): boolean;
}

export function createLinkBinder(deps: LinkBinderDeps): LinkBinder {
  const codecs = createAgentEditCodecFactory(deps.codec);

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

  /**
   * Encode `blocks` as a mutation of `base`: its whole-document overwrite, so
   * blocks left as they were keep their items, with the overwrite's certified
   * provenance written against the base; fresh, a plain insertion.
   */
  function prepared(input: {
    holder: PreparedHolder;
    base: {
      doc: Y.Doc;
      authority: Readonly<CheckpointAuthority>;
      documentId: DocumentId;
      codec: AgentEditCodec;
    } | null;
    blocks: readonly PMNode[];
    markdown: string;
    schemaType: YjsTrackedSchemaType;
  }): PreparedWrite {
    const draft = createCollabYDoc({ gc: false });
    try {
      if (input.base) Y.applyUpdate(draft, Y.encodeStateAsUpdate(input.base.doc));
      const baseVector = Y.encodeStateVector(draft);
      let ir: SemanticEditIRV1 | null = null;
      if (input.base) {
        const lowered = lowerOverwrite({
          doc: draft,
          model: deps.model,
          codec: input.base.codec,
          documentId: input.base.documentId,
          content: input.markdown,
          blocks: input.blocks,
        });
        if (!lowered.ok) {
          throw new Error(`Could not prepare the write: ${lowered.code}: ${lowered.message}`);
        }
        ir = lowered.ir;
      } else if (input.blocks.length > 0) {
        draft.transact(() => {
          deps.model.insertBlocks(toDocHandle(draft), null, { blocks: [...input.blocks] });
        });
      }
      const update = Y.encodeStateAsUpdate(draft, baseVector);
      // Facts are written after `update` is taken: a writer's fresh save must not carry them.
      let certified: PreparedWrite["certified"] = null;
      if (ir) {
        const loweredVector = Y.encodeStateVector(draft);
        deps.semanticProvenance.writeCertifiedFacts(toDocHandle(draft), ir, baseVector);
        certified = { ir, provenance: Y.encodeStateAsUpdate(draft, loweredVector) };
      }
      return {
        holder: input.holder,
        base: input.base ? { authority: input.base.authority, stateVector: baseVector } : null,
        update,
        certified,
        blocks: input.blocks,
        markdown: input.markdown,
        schemaType: input.schemaType,
      } as PreparedWrite;
    } finally {
      draft.destroy();
    }
  }

  /**
   * The holder's current document, as a private clone, with the authority
   * generation it was read in; null if it has no state yet.
   */
  async function currentDocument(
    documentId: DocumentId,
  ): Promise<{ doc: Y.Doc; authority: Readonly<CheckpointAuthority> } | null> {
    let read: { state: Uint8Array; authority: Readonly<CheckpointAuthority> };
    try {
      read = await deps.coordinator.withDocument(documentId, async (doc) => ({
        state: Y.encodeStateAsUpdate(doc),
        authority: documentAuthority(doc),
      }));
    } catch (cause) {
      if (isDocumentNotFoundError(cause)) return null;
      throw cause;
    }
    const clone = createCollabYDoc({ gc: false });
    Y.applyUpdate(clone, read.state);
    return { doc: clone, authority: read.authority };
  }

  async function bind(input: BindMarkdownInput): Promise<PreparedWrite> {
    const { holder } = input;
    const view = input.view ?? LIVE_VIEW;
    const documentId = "documentId" in holder ? holder.documentId : null;
    const holderUri = "documentId" in holder ? null : holder.uri;
    const filetype =
      "documentId" in holder ? await deps.resolveFiletype(holder.documentId) : holder.filetype;
    const schemaType = schemaTypeOf(filetype);
    const preparedHolder: PreparedHolder = documentId
      ? { kind: "document", documentId }
      : { kind: "new", uri: holderUri ?? "" };
    const base =
      input.against === "current" && documentId ? await currentDocument(documentId) : null;
    try {
      const previous = base ? [...deps.model.projectBlocks(toDocHandle(base.doc))] : [];
      const prepare = async (written: readonly PMNode[]) => {
        await deps.links.prepare({
          holders: documentId ? [{ documentId, view }] : [],
          stored: previous,
          written,
          ...(documentId ? {} : { addresses: writtenAddresses(written, holderUri), views: [view] }),
        });
      };
      const scopeFor = (): HolderLinkScope =>
        documentId
          ? deps.links.holder({ documentId, view })
          : deps.links.reader({ uri: holderUri, view });
      /** Called once the scope is prepared: the overwrite of a base spells through it. */
      const finish = (blocks: readonly PMNode[], markdown: string) =>
        prepared({
          holder: preparedHolder,
          base: base && documentId ? { ...base, documentId, codec: codecs.bind(scopeFor()) } : null,
          blocks,
          markdown,
          schemaType,
        });

      const { markdown } = input;
      if (schemaType === "code") {
        if (base) await prepare([]);
        return finish([codeBlock(markdown, filetype)], markdown);
      }

      const written = deps.codec.parse(markdown).blocks;
      await prepare(written);
      const scope = scopeFor();
      const assigned = assignLinkRefs({
        old: walkLinkOccurrences(previous),
        written,
        scope,
        holderDocumentId: documentId ?? "",
        shown: [],
      });
      await register(assigned.minted, scope);
      return finish(assigned.nodes, markdown);
    } finally {
      base?.doc.destroy();
    }
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
      const key =
        "documentId" in input.holder
          ? { documentId: input.holder.documentId }
          : { projectId: input.holder.projectId };
      return deps.links.within(key, () => bind(input));
    },

    bindStatic(markdown, filetype = null) {
      const schemaType = schemaTypeOf(filetype);
      const holder: PreparedHolder = { kind: "static" };
      if (schemaType === "code") {
        return prepared({
          holder,
          base: null,
          blocks: [codeBlock(markdown, filetype)],
          markdown,
          schemaType,
        });
      }
      const blocks = deps.codec.parse(markdown).blocks;
      if (walkLinkOccurrences(blocks).length > 0) {
        throw new Error("Static content names a link or source; bind it with bindMarkdown");
      }
      return prepared({ holder, base: null, blocks, markdown, schemaType });
    },
  };
}
