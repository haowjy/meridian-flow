/** In-memory ContextTreeMutationStore conformance harness. */
import {
  createInMemoryContextDocumentStoreBacking,
  InMemoryContextDocumentStore,
  InMemoryContextTreeMutationStore,
} from "../in-memory-store.js";
import { describeContextTreeMutationStoreConformance } from "./context-tree-mutation-store.conformance.js";

describeContextTreeMutationStoreConformance("in-memory", () => {
  const backing = createInMemoryContextDocumentStoreBacking();
  const sourceA = "00000000-0000-4000-8000-0000000000a1";
  const sourceB = "00000000-0000-4000-8000-0000000000b1";
  return {
    sourceA,
    sourceB,
    storeA: new InMemoryContextDocumentStore({ sourceId: sourceA, backing }),
    storeB: new InMemoryContextDocumentStore({ sourceId: sourceB, backing }),
    mutationStore: new InMemoryContextTreeMutationStore(backing),
  };
});
