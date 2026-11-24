/** Derives live outputs from durable cuts; timers are hints, database staleness is authority. */

import { createHash } from "node:crypto";
import { countWords } from "@meridian/agent-edit/diff";
import {
  type AgentEditCodecFactory,
  type LoroDocument,
  loroModel,
} from "@meridian/agent-edit/integration";
import type { DocumentId } from "@meridian/contracts/runtime";
import { encodeRoomVersion } from "@meridian/document-model";
import { walkLinkOccurrences } from "@meridian/markup/links";
import type { StoredLinkOccurrence } from "@meridian/markup/stored-links";
import type { Schema } from "prosemirror-model";
import { createKeyedCoalescer } from "../../../shared/keyed-coalescer.js";
import { type DocumentLinkRow, deriveDocumentLinkRows } from "./document-link-rows.js";
import { isCodeDocument } from "./document-schema-type.js";
import { grepBlocksOf } from "./grep-blocks.js";
import type {
  DerivedBlock,
  DocumentDerivationCut,
  DocumentDerivationOutputs,
  DocumentDerivationResult,
  DocumentDerivationService,
  DocumentDerivationStore,
} from "./ports/document-derivations.js";

/** What the derivation reads a cut with: the model that projects it, the codec that spells it. */
export type ReadCut = (documentId: DocumentId, doc: LoroDocument) => Promise<CutRead>;

/** A cut as Live reads it: its blocks and links. */
export type CutRead = {
  blocks: DerivedBlock[];
  links: StoredLinkOccurrence[];
};

export function createDocumentDerivationService(input: {
  store: DocumentDerivationStore;
  readCut: ReadCut;
  outsideTransaction<T>(operation: () => T): T;
  deferred(documentId: DocumentId): void;
  failed(documentId: DocumentId, cause: unknown): void;
}): DocumentDerivationService {
  let sweepCursor: DocumentId | undefined;
  let aheadCursor: string | undefined;

  const derive = async (documentId: DocumentId, at?: Date) => {
    const result = await deriveDocument(input, documentId, at);
    if (result.status === "deferred") input.deferred(documentId);
    return result;
  };

  const scheduled = createKeyedCoalescer<DocumentId>({
    debounceMs: 2000,
    maxMs: 10000,
    outsideTransaction: input.outsideTransaction,
    // A direct write derives inline, so most notices find the document already certified.
    run: async (documentId) => {
      if ((await input.store.stale({ only: documentId, limit: 1 })).length)
        await derive(documentId);
    },
    onError: input.failed,
  });

  async function recover(ids: DocumentId[]): Promise<void> {
    for (const id of ids) {
      try {
        await derive(id);
      } catch (cause) {
        input.failed(id, cause);
      }
    }
  }

  return {
    derive,
    schedule: scheduled.schedule,
    sweep() {
      return input.outsideTransaction(async () => {
        const ids = await input.store.stale({ after: sweepCursor, limit: 100 });
        sweepCursor = ids.length === 100 ? ids.at(-1) : undefined;
        await recover(ids);
        // Bounded and fair: resumes after the last ref attempted, so failing refs rotate through.
        aheadCursor = (await input.store.recoverAheads(aheadCursor)).next ?? undefined;
        return ids.length;
      });
    },
    async stop() {
      await scheduled.stop();
    },
  };
}

export async function deriveDocument(
  input: { store: DocumentDerivationStore; readCut: ReadCut },
  documentId: DocumentId,
  at = new Date(),
): Promise<DocumentDerivationResult> {
  // Retry only stale cuts, not serializer/database failures. A constantly edited
  // document yields to the next hint or sweep instead of monopolizing a worker.
  for (let attempt = 0; attempt < 3; attempt++) {
    const cut = await input.store.capture(documentId);
    if (!cut) return { status: "missing" };
    try {
      const version = encodeRoomVersion(cut.doc.docs.version());
      const outputs = await deriveDocumentOutputs(cut, input.readCut);
      if (await input.store.certify(cut, outputs, at)) {
        // Also when the cut was already certified: a failed earlier registration retries here.
        if (outputs.links.some((row) => row.aheadId)) await input.store.registerAheads(documentId);
        return { status: "derived", version };
      }
    } finally {
      cut.doc.docs.free();
    }
  }
  return { status: "deferred" };
}

/** The blocks and link rows of the cut's document. */
export async function deriveDocumentOutputs(
  cut: DocumentDerivationCut,
  readCut: ReadCut,
): Promise<DocumentDerivationOutputs> {
  const read = await readCut(cut.documentId, cut.doc);
  const { blocks } = read;
  const links = cut.holderUri
    ? deriveDocumentLinkRows({ occurrences: read.links, holderUri: cut.holderUri })
    : [];
  return {
    blocks,
    wordCount: blocks.reduce((sum, block) => sum + countWords(block.text), 0),
    documentBytes: blocks.reduce((sum, block) => sum + Buffer.byteLength(block.text, "utf8"), 0),
    documentHash: documentHash(blocks, links),
    links,
  };
}

/**
 * The cut's blocks in document order as Live reads them, normalized and hashed here, before the
 * certify transaction: nothing downstream reads text back under the lock.
 */
export function createCutReader(deps: {
  schema: Schema;
  /** A thunk: the runtime that owns the codec is built after the derivation service. */
  codec(): AgentEditCodecFactory;
  resolveFiletype(documentId: DocumentId): Promise<string | null>;
}): ReadCut {
  const model = loroModel(deps.schema);
  return async (documentId, doc) => {
    const verbatim = await isCodeDocument(deps.resolveFiletype, documentId);
    const read = grepBlocksOf(doc, model, deps.codec().markup, verbatim);
    return {
      blocks: read.map(({ block, destinationFree, text }) => ({
        id: block.key,
        text,
        contentHash: sha256(destinationFree),
      })),
      links: walkLinkOccurrences(read.map(({ block }) => block.node)).map(({ kind, attrs }) => ({
        kind,
        ref: attrs.ref,
        href: attrs.href,
      })),
    };
  };
}

function sha256(text: string): Buffer {
  return createHash("sha256").update(text, "utf8").digest();
}

/** A hash over what an edit changes: the blocks in order, and the certified links they hold. */
export function documentHash(
  blocks: readonly { contentHash: Buffer }[],
  links: readonly DocumentLinkRow[],
): Buffer {
  const hash = createHash("sha256");
  for (const block of blocks) hash.update(block.contentHash);
  hash.update(Uint8Array.of(0));
  const facts = links.map((row) => JSON.stringify([row.linkKey, row.address, row.occurrences]));
  hash.update(facts.sort().join("\n"), "utf8");
  return hash.digest();
}
