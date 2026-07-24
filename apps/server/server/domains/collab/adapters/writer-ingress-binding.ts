/** Late-bound writer-ingress barrier shared by transport and branch push. */
import type { WriterIngressBarrier } from "../domain/ports/writer-ingress-barrier.js";

export function createWriterIngressBinding() {
  let bound: WriterIngressBarrier | null = null;
  return {
    bind(barrier: WriterIngressBarrier): void {
      bound = barrier;
    },
    barrier: {
      drain: (documentId) => bound?.drain(documentId) ?? Promise.resolve(0),
      isGenerationCurrent: (documentId, generation) =>
        bound?.isGenerationCurrent(documentId, generation) ?? true,
    } satisfies WriterIngressBarrier,
  };
}
