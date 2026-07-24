/** Public barrel for collab domain contracts and composition factories. */

export { createCollabDomain, createInMemoryCollabDomain } from "./composition.js";
export * from "./contracts.js";
export {
  isStaleDocumentSchemaError,
  isStaleSchema,
  StaleDocumentSchemaError,
} from "./domain/stale-schema.js";
