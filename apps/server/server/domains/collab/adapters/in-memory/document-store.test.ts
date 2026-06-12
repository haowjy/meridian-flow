import { describeDocumentStoreConformance } from "../__conformance__/document-store.conformance.js";
import { createInMemoryDocumentStore } from "./document-store.js";

describeDocumentStoreConformance("in-memory", () => createInMemoryDocumentStore());
