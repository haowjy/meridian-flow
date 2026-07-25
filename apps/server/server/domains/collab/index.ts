/** Public barrel for collab domain contracts and composition factories. */

export { createInMemoryCollabDomain } from "./adapters/in-memory/composition.js";
export { createCollabDomain } from "./composition.js";
export * from "./contracts.js";
export { createDocumentCreationAggregate } from "./domain/document-creation.js";
export {
  isStaleDocumentSchemaError,
  isStaleSchema,
  StaleDocumentSchemaError,
} from "./domain/stale-schema.js";
