/** Domain-facing proof that all admitted writer updates reached durable storage. */
import type { DocumentId } from "@meridian/contracts/runtime";

export interface WriterIngressBarrier {
  /** Drain admissions already started and return the generation that was drained. */
  drain(documentId: DocumentId): Promise<number>;
  /** False when another admission started after the drained generation was captured. */
  isGenerationCurrent(documentId: DocumentId, generation: number): boolean;
}
