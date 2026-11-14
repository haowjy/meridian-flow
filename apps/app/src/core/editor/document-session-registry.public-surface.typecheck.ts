/** Compile-negative proof that live sessions cannot bypass leases or reveal the implementation. */
import type { DocumentId } from "@meridian/contracts/runtime";
import type { LiveDocumentSessionRegistry } from "./document-session-registry";

declare const registry: LiveDocumentSessionRegistry;
declare const documentId: DocumentId;
declare const ownerId: string;

// @ts-expect-error live get requires a lease
registry.get(documentId);
// @ts-expect-error restart requires a lease
registry.restartUnavailableRoom(documentId);
// @ts-expect-error retain requires leases, not ids
registry.retain(ownerId, [documentId]);
// @ts-expect-error immutable account runtime owns account identity
registry.setOwnUserId("account");
// @ts-expect-error lifecycle is not part of the structural registry
registry.destroyAll();
type PublicRegistryModule = typeof import("./document-session-registry");
// @ts-expect-error concrete implementation is not exported by the public module
export type ConcreteRegistryMustRemainPrivate = PublicRegistryModule["DocumentSessionRegistry"];
