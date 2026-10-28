/** Derives live outputs from durable cuts; timers are hints, database staleness is authority. */

import { createHash } from "node:crypto";
import { destinationFreeBlocks, grepBlockText } from "@meridian/agent-edit";
import {
  type AgentEditCodecFactory,
  blockItemIdKey,
  toDocHandle,
  type YProsemirrorDocumentModel,
} from "@meridian/agent-edit/integration";
import type { DocumentId } from "@meridian/contracts/runtime";
import { extractStoredLinks } from "@meridian/markup/stored-links";
import { createCollabYDoc, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { type DocumentLinkRow, deriveDocumentLinkRows } from "./document-link-rows.js";
import { isCodeDocument } from "./document-schema-type.js";
import type {
  DerivationScope,
  DerivedBlock,
  DocumentDerivationCut,
  DocumentDerivationOutputs,
  DocumentDerivationResult,
  DocumentDerivationService,
  DocumentDerivationStore,
} from "./ports/document-derivations.js";
import { countWords } from "./word-count.js";

/**
 * What the derivation reads a cut with: the model that projects it, the codec that spells it.
 * Injected as a function because the runtime owning the model is built after this service.
 */
export type DeriveBlocks = (documentId: DocumentId, doc: Y.Doc) => Promise<DerivedBlock[]>;

export function createDocumentDerivationService(input: {
  store: DocumentDerivationStore;
  deriveBlocks: DeriveBlocks;
  outsideTransaction<T>(operation: () => T): T;
  deferred(documentId: DocumentId): void;
  failed(documentId: DocumentId, cause: unknown): void;
}): DocumentDerivationService {
  const timers = new Map<DocumentId, { trailing?: NodeJS.Timeout; maximum?: NodeJS.Timeout }>();
  const running = new Map<DocumentId, Promise<void>>();
  const rerun = new Set<DocumentId>();
  let stopped = false;
  let sweepCursor: DocumentId | undefined;
  let aheadCursor: string | undefined;

  const derive = async (documentId: DocumentId, at?: Date) => {
    const result = await deriveDocument(input, documentId, at);
    if (result.status === "deferred") input.deferred(documentId);
    return result;
  };

  function clear(documentId: DocumentId) {
    const entry = timers.get(documentId);
    if (entry?.trailing) clearTimeout(entry.trailing);
    if (entry?.maximum) clearTimeout(entry.maximum);
    timers.delete(documentId);
  }

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
    schedule(documentId) {
      if (stopped) return;
      input.outsideTransaction(() => {
        const entry = timers.get(documentId) ?? {};
        const start = () => {
          clear(documentId);
          if (running.has(documentId)) {
            rerun.add(documentId);
            return;
          }
          const operation = (async () => {
            do {
              rerun.delete(documentId);
              try {
                await derive(documentId);
              } catch (cause) {
                input.failed(documentId, cause);
              }
            } while (!stopped && rerun.has(documentId));
          })().finally(() => {
            running.delete(documentId);
            rerun.delete(documentId);
          });
          running.set(documentId, operation);
        };
        if (entry.trailing) clearTimeout(entry.trailing);
        entry.trailing = setTimeout(start, 2000);
        entry.maximum ??= setTimeout(start, 10000);
        entry.trailing.unref();
        entry.maximum.unref();
        timers.set(documentId, entry);
      });
    },
    sweep() {
      return input.outsideTransaction(async () => {
        const ids = await input.store.stale(undefined, { after: sweepCursor, limit: 100 });
        sweepCursor = ids.length === 100 ? ids.at(-1) : undefined;
        await recover(ids);
        // Bounded and fair: resumes after the last ref attempted, so failing refs rotate through.
        aheadCursor = (await input.store.recoverAheads(aheadCursor)).next ?? undefined;
        return ids.length;
      });
    },
    flush(scope: DerivationScope) {
      return input.outsideTransaction(async () => {
        let after: DocumentId | undefined;
        while (true) {
          const ids = await input.store.stale(scope, { after, limit: 100 });
          await recover(ids);
          if (ids.length < 100) break;
          after = ids.at(-1);
        }
        // A move waits for this: every certified ahead ref is registered before it locks.
        await input.store.drainAheads(scope);
      });
    },
    async stop() {
      stopped = true;
      for (const id of timers.keys()) clear(id);
      await Promise.all(running.values());
    },
  };
}

export async function deriveDocument(
  input: { store: DocumentDerivationStore; deriveBlocks: DeriveBlocks },
  documentId: DocumentId,
  at = new Date(),
): Promise<DocumentDerivationResult> {
  // Retry only stale cuts, not serializer/database failures. A constantly edited
  // document yields to the next hint or sweep instead of monopolizing a worker.
  for (let attempt = 0; attempt < 3; attempt++) {
    const cut = await input.store.capture(documentId);
    if (!cut) return { status: "missing" };
    const doc = createCollabYDoc({ gc: false });
    try {
      Y.applyUpdate(doc, cut.state);
      // Before projecting: a repair there edits the private doc, not the cut.
      const stateVector = Y.encodeStateVector(doc);
      const outputs = await deriveDocumentOutputs(cut, doc, input.deriveBlocks);
      if (await input.store.certify(cut, outputs, at)) {
        // Also when the cut was already certified: a failed earlier registration retries here.
        if (outputs.links.some((row) => row.aheadId)) await input.store.registerAheads(documentId);
        return { status: "derived", stateVector };
      }
    } finally {
      doc.destroy();
    }
  }
  return { status: "deferred" };
}

/** The blocks and link rows of one private document, which the projection may repair in place. */
export async function deriveDocumentOutputs(
  cut: DocumentDerivationCut,
  doc: Y.Doc,
  deriveBlocks: DeriveBlocks,
): Promise<DocumentDerivationOutputs> {
  const blocks = await deriveBlocks(cut.documentId, doc);
  const links = !cut.holderUri
    ? []
    : deriveDocumentLinkRows({
        occurrences: extractStoredLinks(doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME)),
        holderUri: cut.holderUri,
      });
  return {
    blocks,
    wordCount: blocks.reduce((sum, block) => sum + block.wordCount, 0),
    documentBytes: blocks.reduce((sum, block) => sum + Buffer.byteLength(block.text, "utf8"), 0),
    documentHash: documentHash(blocks, links),
    links,
  };
}

/**
 * The cut's blocks in document order, normalized and hashed here, before the certify
 * transaction: nothing downstream reads text back under the lock. The doc is the derivation's
 * own, so the projection runs on it with no copy.
 */
export function createBlockDeriver(deps: {
  model: YProsemirrorDocumentModel;
  codec: AgentEditCodecFactory;
  resolveFiletype(documentId: DocumentId): Promise<string | null>;
}): DeriveBlocks {
  return async (documentId, doc) => {
    const verbatim = await isCodeDocument(deps.resolveFiletype, documentId);
    const projected = deps.model.projectBlocks(toDocHandle(doc));
    const free = destinationFreeBlocks(
      deps.codec.markup,
      projected.map((block) => block.node),
    );
    return projected.map((block, index) => {
      const text = grepBlockText(free[index] as string, block.node, verbatim);
      return {
        id: blockItemIdKey(block.id),
        text,
        contentHash: sha256(free[index] as string),
        wordCount: countWords(text),
      };
    });
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
