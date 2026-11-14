// One write's save through its host: the durable append and its cut, then the accepted save's
// report (revision), which never fails the save.
import * as Y from "yjs";
import { toDocHandle } from "../handles.js";
import { type BlockOriginMap, bindBlockOrigins } from "../model/block-hash.js";
import {
  type DocumentCoordinator,
  type SaveCut,
  SavePreconditionRefused,
} from "../ports/document-coordinator.js";
import type { DocumentLinksPort } from "../ports/document-links.js";
import type { AgentEditModel } from "../ports/model.js";
import type { JournalBatchAppendEntry } from "../ports/update-journal.js";
import type { CommandLinks } from "./command-links.js";
import type { InternalWriteResult } from "./internal-result.js";

export interface SaveInput {
  docId: string;
  entry: JournalBatchAppendEntry;
  links: CommandLinks;
  /** The Work draft a model edit saves to, as the host ensured it; live when absent. */
  workDraftId?: string;
  /**
   * A create without overwrite lands only in a document still empty when its append reads it
   * under the document's lock; otherwise this is the answer.
   */
  refuseUnlessEmpty?: InternalWriteResult;
}

/** A write saved: its report, and the room as the save left it. */
export interface Saved {
  revision: string | null;
  /** Revision reporting failed after persistence; the save itself still landed. */
  awarenessDegraded?: true;
  afterState: Uint8Array;
  position?: number;
}

export interface DocumentSave {
  /**
   * Saves one write through the host port: its one entry kept or refused, persisted, handed
   * over, and reported on the append's cut. Once persisted it is accepted: a reporting failure
   * degrades it, never fails it.
   */
  save(input: SaveInput): Promise<Saved | InternalWriteResult>;
}

export function createDocumentSave(deps: {
  coordinator: DocumentCoordinator;
  model: AgentEditModel;
  links: DocumentLinksPort;
}): DocumentSave {
  const { coordinator } = deps;

  return {
    async save(input) {
      const { refuseUnlessEmpty } = input;
      const saved = await coordinator.prepareSave({
        docId: input.docId,
        entries: [input.entry],
        ...(input.workDraftId ? { access: { workDraftId: input.workDraftId } } : {}),
        ...(refuseUnlessEmpty ? { precondition: holdsNoBlocks } : {}),
      });
      const { write } = saved;
      let persisted = false;
      try {
        if (write.kind === "no-effect")
          throw new Error(`Host reported no effect for a kept write on ${input.docId}`);
        let cut: SaveCut;
        try {
          cut = await write.persist();
        } catch (cause) {
          if (refuseUnlessEmpty && cause instanceof SavePreconditionRefused)
            return refuseUnlessEmpty;
          throw cause;
        }
        persisted = true;
        write.transfer();
        return reportAccepted(
          cut,
          { revision: null, awarenessDegraded: true, afterState: cut.afterState },
          saved.blockOrigins,
          async (after) => ({
            ...reportRevision(after, input.links, deps.links),
            afterState: cut.afterState,
            ...(cut.position === undefined ? {} : { position: cut.position }),
          }),
        );
      } finally {
        if (!persisted && write.kind === "write") write.dispose();
      }
    },
  };

  /** Whether a document's state holds no blocks: a create without overwrite's precondition. */
  function holdsNoBlocks(state: Uint8Array): boolean {
    const doc = docFromState(state);
    try {
      return deps.model.getBlocks(toDocHandle(doc)).length === 0;
    } finally {
      doc.destroy();
    }
  }
}

/**
 * The reporting boundary of an accepted save: `run` reads the append's cut, and any failure in
 * it answers `degraded`, never an error. The write is already persisted, so an error here would
 * invite a retry that writes it twice.
 */
async function reportAccepted<T>(
  cut: SaveCut,
  degraded: T,
  blockOrigins: BlockOriginMap | undefined,
  run: (after: Y.Doc) => Promise<T>,
): Promise<T> {
  let after: Y.Doc | undefined;
  try {
    after = docFromState(cut.afterState, blockOrigins);
    return await run(after);
  } catch {
    return degraded;
  } finally {
    after?.destroy();
  }
}

function reportRevision(
  after: Y.Doc,
  links: CommandLinks,
  port: DocumentLinksPort,
): { revision: string | null; awarenessDegraded?: true } {
  try {
    return { revision: port.revision(after, links.scope) };
  } catch {
    return { revision: null, awarenessDegraded: true };
  }
}

function docFromState(state: Uint8Array, blockOrigins?: BlockOriginMap): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  Y.applyUpdate(doc, state);
  if (blockOrigins) bindBlockOrigins(doc, blockOrigins);
  return doc;
}
