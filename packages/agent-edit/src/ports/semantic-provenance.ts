// Adapter seam for appending certified continuation/restoration facts to the same Yjs update.

import type { DocHandle } from "../handles.js";
import type { SemanticEditIRV1 } from "../semantic-edit-ir.js";

export interface SemanticProvenanceWriter {
  /** Synchronous by design: facts and prose must be captured by one encoded Yjs update. */
  writeCertifiedFacts(doc: DocHandle, ir: SemanticEditIRV1): void;
}
