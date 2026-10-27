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
 * hoist fails at once. A copy is the exception: its content is already bound to
 * identities by `copied-blocks.ts`, so `bindCopiedBlocks` spells nothing
 * against a catalog and mints nothing, and may run where the copy's names are
 * final (inside its transaction).
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
  type AheadMint,
  assignLinkRefs,
  assignOccurrences,
  isDocumentNotFoundError,
  rebuildOccurrences,
  toDocHandle,
  type YProsemirrorDocumentModel,
} from "@meridian/agent-edit/integration";
import { documentRef, type LinkView, parseLinkRef } from "@meridian/contracts";
import { classifyFiletype, type YjsTrackedSchemaType } from "@meridian/contracts/protocol";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { MarkupCodec, PMNode } from "@meridian/markup";
import { walkLinkOccurrences, writtenAddresses } from "@meridian/markup/links";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import type { Schema } from "prosemirror-model";
import * as Y from "yjs";
import { type CopyIdentityMap, remapCopiedBlocks } from "./copied-blocks.js";
import { aheadRegistrations } from "./document-links-port.js";
import {
  type AheadRefRegistrar,
  type DocumentLinkScopes,
  type HolderLinkScope,
  LIVE_VIEW,
} from "./ports/document-link-scope.js";
import type { LiveDocumentCoordinator } from "./ports/live-document-coordinator.js";

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

/**
 * A copy's content: one stored document's blocks for a document about to be created at
 * `uri`. The copy's remap has already rewritten the identities it copies and left every
 * other link naming its target, so binding spells no link freshly and mints nothing; it
 * only gives the blocks the holder and schema type the new document needs.
 */
export interface BindCopiedBlocksInput {
  /** The address the new document will have. */
  uri: string;
  /** The new document's filetype, as its create resolved it. */
  filetype: string | null;
  /** The source holder's address: a stored relative spelling was written against it. */
  sourceHolderUri: string | null;
  blocks: readonly PMNode[];
  map: CopyIdentityMap;
  /** Where each `ahead:` ref settles now (`EffectiveBlocksRead.aheadSettlements`). */
  aheadSettlements?: ReadonlyMap<string, string>;
}

export interface LinkBinder {
  /**
   * Outside any transaction: open the holder's scope, parse, prepare, assign
   * (fresh, or against the current document) and register minted ahead refs.
   */
  bindMarkdown(input: BindMarkdownInput): Promise<BoundWrite>;
  /**
   * A copied document's blocks for a fresh holder (`copied-blocks.ts` owns the remap).
   * Pure: it resolves no catalog and mints no ahead ref, so it may run inside a
   * transaction. The result is a fresh write: it lands only in an empty document.
   */
  bindCopiedBlocks(input: BindCopiedBlocksInput): BoundWrite;
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
  coordinator: Pick<LiveDocumentCoordinator, "withDocument">;
  links: DocumentLinkScopes;
  registrar: AheadRefRegistrar;
  resolveFiletype(documentId: DocumentId): Promise<string | null>;
  inTransaction(): boolean;
}

/**
 * Content parsed with every link unbound (`ref` null, href as written), in the shape its
 * filetype stores: one code block for a code file. Static seeds take it when nothing in it
 * is a link; repair takes it as a stored projection's best reading, since binding mints
 * ahead refs in a root transaction that a repair's caller may already be inside.
 */
export function createUnboundParser(deps: { codec: MarkupCodec; schema: Schema }) {
  return (markdown: string, filetype: string | null) => {
    const schemaType = schemaTypeOf(filetype);
    const blocks: PMNode[] =
      schemaType === "code"
        ? [
            deps.schema.nodes.code_block.create(
              { language: filetype },
              markdown.length > 0 ? deps.schema.text(markdown) : undefined,
            ),
          ]
        : deps.codec.parse(markdown).blocks;
    return { schemaType, blocks };
  };
}

function schemaTypeOf(filetype: string | null): YjsTrackedSchemaType {
  const classification = classifyFiletype(filetype);
  if (classification.kind === "tracked") return classification.schemaType;
  if (classification.kind === "unknown") return "document";
  throw new Error(`Cannot bind ${classification.kind} content as a tracked document`);
}

export function createLinkBinder(deps: LinkBinderDeps): LinkBinder {
  const parseUnbound = createUnboundParser(deps);

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
    const parsed = parseUnbound(markdown, filetype);
    if (schemaType === "code") return finish(parsed.blocks, markdown);

    const written = parsed.blocks;
    const addresses = documentId ? [] : writtenAddresses(written, holderUri);
    await deps.links.prepare({
      holders: documentId ? [{ documentId, view }] : [],
      stored: previous ?? [],
      written,
      ...(documentId
        ? {}
        : {
            addresses: addresses
              .filter((target) => target.kind === "document")
              .map((target) => target.uri),
            folderAddresses: addresses
              .filter((target) => target.kind === "folder")
              .map((target) => target.uri),
            views: [view],
          }),
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
      if ("targets" in input || "hrefs" in input || "plannedHolderId" in input)
        throw new Error("Planned targets require the import binder");
      const key =
        "documentId" in input.holder
          ? { documentId: input.holder.documentId }
          : { projectId: input.holder.projectId };
      return deps.links.within(key, () => bind(input));
    },

    bindCopiedBlocks(input) {
      const blocks = remapCopiedBlocks({
        blocks: input.blocks,
        map: input.map,
        sourceHolderUri: input.sourceHolderUri,
        ...(input.aheadSettlements ? { aheadSettlements: input.aheadSettlements } : {}),
      });
      // Stored hrefs are already what the wire shows; the pass-through scope keeps them.
      const markdown = deps.codec.serialize(blocks, {
        spellLink: ({ href }) => ({ href, address: null }),
        spellSource: ({ src }) => ({ href: src, address: null }),
      });
      return boundWrite({
        holder: { kind: "new", uri: input.uri },
        fresh: true,
        blocks,
        markdown,
        schemaType: schemaTypeOf(input.filetype),
      });
    },

    bindStatic(markdown, filetype = null) {
      const { schemaType, blocks } = parseUnbound(markdown, filetype);
      if (schemaType !== "code" && walkLinkOccurrences(blocks).length > 0) {
        throw new Error("Static content names a link or source; bind it with bindMarkdown");
      }
      return boundWrite({ holder: { kind: "static" }, fresh: true, blocks, markdown, schemaType });
    },
  };
}

/** Identity overrides are an import-only capability, never on the model/editor binder. */
export interface ImportLinkBinder {
  bindPlannedCode(documentId: DocumentId, filetype: string, text: string): BoundWrite;
  bindMarkdown(input: ImportBindInput): Promise<BoundWrite>;
  bindPlannedMarkdown(
    input: PlannedMarkdownInput,
  ): Promise<{ content: BoundWrite; aheadMints: AheadMint[] }>;
}

export type ImportBindInput = Omit<BindMarkdownInput, "against"> & {
  targets?: ReadonlyMap<number, DocumentId>;
  hrefs?: ReadonlyMap<number, string>;
};

export type PlannedMarkdownInput = Pick<ImportBindInput, "markdown" | "targets" | "hrefs"> & {
  holder: { documentId: DocumentId; uri: string; projectId: string; filetype: string | null };
  planned: ReadonlySet<DocumentId>;
};

export type ImportLinkBinderDeps = Omit<LinkBinderDeps, "coordinator" | "model">;

export function createImportLinkBinder(deps: ImportLinkBinderDeps): ImportLinkBinder {
  const makeBound = (input: Omit<BoundWrite, typeof boundBrand>) => input as BoundWrite;

  function code(documentId: DocumentId, filetype: string, text: string): BoundWrite {
    const classification = classifyFiletype(filetype);
    if (classification.kind !== "tracked" || classification.schemaType !== "code")
      throw new Error("Planned code binding requires a code filetype");
    return makeBound({
      holder: { kind: "document", documentId },
      fresh: true,
      blocks: [
        deps.schema.nodes.code_block.create(
          { language: filetype },
          text.length > 0 ? deps.schema.text(text) : undefined,
        ),
      ],
      markdown: text,
      schemaType: "code",
    });
  }

  async function bindFresh(
    input: ImportBindInput & {
      planned?: ReadonlySet<DocumentId>;
      plannedHolderId?: DocumentId;
      returnAhead?: true;
    },
  ): Promise<{ content: BoundWrite; aheadMints: AheadMint[] }> {
    if (deps.inTransaction()) throw new LinkBindingInsideTransactionError();
    if (input.view && input.view.kind !== "live")
      throw new Error("Import binding requires a live view");
    const holder = input.holder;
    const documentId = "documentId" in holder ? holder.documentId : null;
    const holderUri = "documentId" in holder ? null : holder.uri;
    const filetype =
      "documentId" in holder ? await deps.resolveFiletype(holder.documentId) : holder.filetype;
    const classification = classifyFiletype(filetype);
    const schemaType =
      classification.kind === "tracked"
        ? classification.schemaType
        : classification.kind === "unknown"
          ? "document"
          : null;
    if (!schemaType)
      throw new Error(`Cannot bind ${classification.kind} content as a tracked document`);
    if (schemaType === "code") {
      const holderId = input.plannedHolderId ?? documentId;
      if (!holderId) throw new Error("Planned code requires its document identity");
      return {
        content: code(holderId, filetype ?? "text", input.markdown),
        aheadMints: [],
      };
    }

    const key =
      "documentId" in holder ? { documentId: holder.documentId } : { projectId: holder.projectId };
    return deps.links.within(key, async () => {
      const parsed = deps.codec.parse(input.markdown).blocks;
      const spelled = walkLinkOccurrences(parsed);
      for (const occurrence of [...(input.targets?.keys() ?? []), ...(input.hrefs?.keys() ?? [])]) {
        if (!Number.isInteger(occurrence) || occurrence < 0 || occurrence >= spelled.length)
          throw new RangeError(`Invalid link occurrence: ${occurrence}`);
      }
      const occurrences = spelled.map((occurrence, index) => {
        const href = input.hrefs?.get(index);
        return href === undefined
          ? occurrence
          : { ...occurrence, attrs: { ...occurrence.attrs, href } };
      });
      const written = input.hrefs?.size
        ? rebuildOccurrences(
            parsed,
            spelled,
            occurrences.map(({ attrs }) => attrs),
          )
        : parsed;
      const writtenTargets = documentId ? [] : writtenAddresses(written, holderUri);
      await deps.links.prepare({
        holders: documentId ? [{ documentId, view: LIVE_VIEW }] : [],
        refs: [...(input.targets?.values() ?? [])]
          .filter((id) => !input.planned?.has(id) && parseLinkRef(`doc:${id}`)?.kind === "doc")
          .map(documentRef),
        stored: [],
        written,
        addresses: writtenTargets
          .filter((target) => target.kind === "document")
          .map((target) => target.uri),
        folderAddresses: writtenTargets
          .filter((target) => target.kind === "folder")
          .map((target) => target.uri),
        ...(documentId ? {} : { views: [LIVE_VIEW] }),
      });
      const scope = documentId
        ? deps.links.holder({ documentId, view: LIVE_VIEW })
        : deps.links.reader({ uri: holderUri, view: LIVE_VIEW });
      const assigned = assignOccurrences({ old: [], written: occurrences, scope, shown: [] });
      const attrs = occurrences.map((occurrence, index) => {
        const target = input.targets?.get(index);
        if (!input.targets?.has(index)) return assigned.attrs[index];
        const parsedRef = parseLinkRef(`doc:${target ?? ""}`);
        const ref = parsedRef?.kind === "doc" ? documentRef(parsedRef.documentId) : null;
        if (ref && input.planned?.has(target as DocumentId)) return { ...occurrence.attrs, ref };
        const resolved = ref ? scope.resolve({ ref, href: occurrence.attrs.href }) : null;
        if (
          resolved?.kind !== "document" ||
          resolved.document.projectId !== scope.holder.projectId ||
          resolved.document.presence !== "live"
        )
          return { ...occurrence.attrs, ref: null, href: "" };
        return { ...occurrence.attrs, ref };
      });
      const nodes = rebuildOccurrences(parsed, spelled, attrs);
      const keptRefs = new Set(walkLinkOccurrences(nodes).map(({ attrs }) => attrs.ref));
      const aheadMints = assigned.minted.filter(({ ref }) => keptRefs.has(ref));
      if (!input.returnAhead && aheadMints.length > 0)
        await deps.registrar.register(aheadRegistrations(aheadMints));
      return {
        content: makeBound({
          holder: input.plannedHolderId
            ? { kind: "document", documentId: input.plannedHolderId }
            : documentId
              ? { kind: "document", documentId }
              : { kind: "new", uri: holderUri ?? "" },
          fresh: true,
          blocks: nodes,
          markdown: input.markdown,
          schemaType,
        }),
        aheadMints,
      };
    });
  }

  return {
    bindPlannedCode: code,
    async bindMarkdown(input) {
      return (await bindFresh(input)).content;
    },
    async bindPlannedMarkdown({ holder, ...input }) {
      const { documentId, ...address } = holder;
      return bindFresh({
        ...input,
        holder: address,
        plannedHolderId: documentId,
        returnAhead: true,
      });
    },
  };
}
