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
  type AheadMint,
  assignOccurrences,
  type DocumentCoordinator,
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

/** Identity overrides are a separate capability, never on the model/editor binder. */
export interface ImportLinkBinder {
  /** Link-free code may be bound to its planned identity before its row exists. */
  bindPlannedCode(documentId: DocumentId, filetype: string, text: string): BoundWrite;
  bindMarkdown(input: ImportBindInput): Promise<BoundWrite>;
  /**
   * Markdown for a document that does not exist yet. Its links spell from
   * `holder.uri`; the write names `holder.documentId`, so the seed admits it
   * only for that id. A target among `planned` binds as `doc:<id>` without
   * resolution, live or not: a ref is authority, and resolves the moment that
   * document's row exists. Any other target resolves as `bindMarkdown` does.
   */
  bindPlannedMarkdown(
    input: PlannedMarkdownInput,
  ): Promise<{ content: BoundWrite; aheadMints: AheadMint[] }>;
}
export type PlannedMarkdownInput = Pick<ImportBindInput, "markdown" | "targets" | "hrefs"> & {
  holder: { documentId: DocumentId; uri: string; projectId: string; filetype: string | null };
  planned: ReadonlySet<DocumentId>;
};
export type ImportBindInput = Omit<BindMarkdownInput, "against"> & {
  /** Identity per occurrence of `markdown`'s own parse. */
  targets?: ReadonlyMap<number, DocumentId>;
  /**
   * Written href per occurrence of `markdown`'s own parse. `markdown` spells
   * these destinations apart, so adjacent links that share an address stay
   * separate occurrences through assignment; equal results merge only after.
   */
  hrefs?: ReadonlyMap<number, string>;
};
/** What the shared binder takes: `plannedHolderId` is the id a not yet existing holder will have. */
type BindInput = BindMarkdownInput &
  ImportBindInput & {
    planned?: ReadonlySet<DocumentId>;
    plannedHolderId?: DocumentId;
    aheadMints?: AheadMint[];
  };

export function createLinkBinder(deps: LinkBinderDeps): LinkBinder {
  return binderFor(deps);
}

/** Fresh identity binding needs no current room or document projection. */
export type ImportLinkBinderDeps = Omit<LinkBinderDeps, "coordinator" | "model">;

/** Only the import tree writer composes this capability; ordinary CollabDomain does not expose it. */
export function createImportLinkBinder(deps: ImportLinkBinderDeps): ImportLinkBinder {
  const binder = binderFor(deps, true);
  return {
    ...binder,
    async bindPlannedMarkdown({ holder, ...rest }) {
      const { documentId, ...address } = holder;
      const aheadMints: AheadMint[] = [];
      const content = await binder.bindMarkdown({
        ...rest,
        holder: address,
        plannedHolderId: documentId,
        aheadMints,
      });
      return { content, aheadMints };
    },
    bindPlannedCode(documentId, filetype, text) {
      const classification = classifyFiletype(filetype);
      if (classification.kind !== "tracked" || classification.schemaType !== "code")
        throw new Error("Planned code binding requires a code filetype");
      const block = deps.schema.nodes.code_block.create(
        { language: filetype },
        text ? deps.schema.text(text) : undefined,
      );
      return {
        holder: { kind: "document", documentId },
        fresh: true,
        blocks: [block],
        markdown: text,
        schemaType: "code",
      } as unknown as BoundWrite;
    },
  };
}

function binderFor(
  deps: LinkBinderDeps | ImportLinkBinderDeps,
  planned = false,
): LinkBinder & { bindMarkdown(input: BindInput): Promise<BoundWrite> } {
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
    if (!("coordinator" in deps)) throw new Error("Import binding is fresh only");
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

  async function bind(input: BindInput): Promise<BoundWrite> {
    const { holder } = input;
    const view = input.view ?? LIVE_VIEW;
    const documentId = "documentId" in holder ? holder.documentId : null;
    const holderUri = "documentId" in holder ? null : holder.uri;
    const filetype =
      "documentId" in holder ? await deps.resolveFiletype(holder.documentId) : holder.filetype;
    const schemaType = schemaTypeOf(filetype);
    const boundHolder: BoundHolder = documentId
      ? { kind: "document", documentId }
      : input.plannedHolderId
        ? { kind: "document", documentId: input.plannedHolderId }
        : { kind: "new", uri: holderUri ?? "" };
    const previous =
      input.against === "current" && documentId ? await currentBlocks(documentId) : null;
    const finish = (blocks: readonly PMNode[], markdown: string) =>
      boundWrite({
        holder: boundHolder,
        fresh: previous === null,
        blocks,
        markdown,
        schemaType,
      });

    const { markdown } = input;
    if (schemaType === "code") return finish([codeBlock(markdown, filetype)], markdown);

    const parsed = deps.codec.parse(markdown).blocks;
    const spelled = walkLinkOccurrences(parsed);
    for (const occurrence of [...(input.targets?.keys() ?? []), ...(input.hrefs?.keys() ?? [])]) {
      if (!Number.isInteger(occurrence) || occurrence < 0 || occurrence >= spelled.length)
        throw new RangeError(`Invalid link occurrence: ${occurrence}`);
    }
    // Occurrences keep the parsed boundaries; only their hrefs are the written ones.
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
    await deps.links.prepare({
      holders: documentId ? [{ documentId, view }] : [],
      refs: [...(input.targets?.values() ?? [])]
        .filter((id) => !input.planned?.has(id) && parseLinkRef(`doc:${id}`)?.kind === "doc")
        .map(documentRef),
      stored: previous ?? [],
      written,
      ...(documentId ? {} : { addresses: writtenAddresses(written, holderUri), views: [view] }),
    });
    const scope: HolderLinkScope = documentId
      ? deps.links.holder({ documentId, view })
      : deps.links.reader({ uri: holderUri, view });
    const assigned = assignOccurrences({
      old: walkLinkOccurrences(previous ?? []),
      written: occurrences,
      scope,
      shown: [],
    });
    const attrs = occurrences.map((occurrence, index) => {
      const target = input.targets?.get(index);
      if (!input.targets?.has(index)) return assigned.attrs[index];
      const parsed = parseLinkRef(`doc:${target ?? ""}`);
      const ref = parsed?.kind === "doc" ? documentRef(parsed.documentId) : null;
      if (ref && input.planned?.has(target as DocumentId)) return { ...occurrence.attrs, ref };
      const resolved = ref ? scope.resolve({ ref, href: occurrence.attrs.href }) : null;
      if (
        resolved?.kind !== "document" ||
        resolved.document.projectId !== scope.holder.projectId ||
        resolved.document.presence !== "live"
      ) {
        return { ...occurrence.attrs, ref: null, href: "" };
      }
      return { ...occurrence.attrs, ref };
    });
    const nodes = rebuildOccurrences(parsed, spelled, attrs);
    const keptRefs = new Set(walkLinkOccurrences(nodes).map(({ attrs }) => attrs.ref));
    const minted = assigned.minted.filter(({ ref }) => keptRefs.has(ref));
    if (input.aheadMints) input.aheadMints.push(...minted);
    else if (minted.length > 0) await deps.registrar.register(aheadRegistrations(minted));
    return boundWrite(finish(nodes, markdown));
  }

  return {
    async bindMarkdown(input) {
      if (deps.inTransaction()) throw new LinkBindingInsideTransactionError();
      if (planned && input.against) throw new Error("Import binding is fresh only");
      if (planned && input.view && input.view.kind !== "live")
        throw new Error("Import binding requires a live view");
      if (!planned && ("targets" in input || "hrefs" in input || "plannedHolderId" in input))
        throw new Error("Planned targets require the import binder");
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
      return boundWrite({
        holder,
        fresh: true,
        blocks,
        markdown,
        schemaType,
      });
    },
  };
}
