/** Derives live outputs from durable cuts; timers are hints, database staleness is authority. */
import type { DocumentId } from "@meridian/contracts/runtime";
import { createCollabYDoc, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { deriveDocumentLinkRows } from "./document-link-rows.js";
import type {
  DerivationScope,
  DocumentDerivationCut,
  DocumentDerivationResult,
  DocumentDerivationService,
  DocumentDerivationStore,
} from "./ports/document-derivations.js";
import type { DurableProjectionSerializer } from "./ports/durable-projection.js";
import { extractStoredLinks } from "./stored-link-extraction.js";

export function createDocumentDerivationService(input: {
  store: DocumentDerivationStore;
  serializer: DurableProjectionSerializer;
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
  input: { store: DocumentDerivationStore; serializer: DurableProjectionSerializer },
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
      const outputs = await deriveDocumentOutputs(cut, doc, input.serializer);
      if (await input.store.certify(cut, outputs, at)) {
        // Also when the cut was already certified: a failed earlier registration retries here.
        if (outputs.links.some((row) => row.aheadId)) await input.store.registerAheads(documentId);
        return { status: "derived", stateVector: Y.encodeStateVector(doc) };
      }
    } finally {
      doc.destroy();
    }
  }
  return { status: "deferred" };
}

/** Projection and link rows always describe the same private document. */
export async function deriveDocumentOutputs(
  cut: DocumentDerivationCut,
  doc: Y.Doc,
  serializer: DurableProjectionSerializer,
) {
  return {
    markdown: await serializer.serializeDocument(cut.documentId, doc),
    links:
      cut.kind === "manifest" || !cut.holderUri
        ? []
        : deriveDocumentLinkRows({
            occurrences: extractStoredLinks(doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME)),
            holderUri: cut.holderUri,
          }),
  };
}
