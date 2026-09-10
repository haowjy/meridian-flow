/** Compile-negative proof that live sessions cannot bypass leases or reveal the implementation. */
import type { DocumentId } from "@meridian/contracts/runtime";
import type { LiveDocumentSessionRegistry } from "./document-session-registry";
import type {
  LocalDocumentSessionAdoptionPort,
  LocalDocumentSessionReservationPort,
} from "./local-document-session-adoption";

declare const registry: LiveDocumentSessionRegistry;
declare const documentId: DocumentId;
declare const ownerId: string;

// @ts-expect-error live get requires a lease
registry.get(documentId);
// @ts-expect-error detached get requires a lease
registry.getDetached(documentId);
// @ts-expect-error attach requires a lease
registry.attachDetached(documentId);
// @ts-expect-error restart requires a lease
registry.restartUnavailableRoom(documentId);
// @ts-expect-error retain requires leases, not ids
registry.retain(ownerId, [documentId]);
// @ts-expect-error immutable account runtime owns account identity
registry.setOwnUserId("account");
// @ts-expect-error lifecycle is not part of the structural registry
registry.destroyAll();
// @ts-expect-error local reservation is a separate private facet
registry.reserve({});
// @ts-expect-error local adoption is a separate private facet
registry.bindAndAdopt({});

declare function localUntitledOwner(port: LocalDocumentSessionReservationPort): void;
declare function projectDocumentLiveOpener(port: LocalDocumentSessionAdoptionPort): void;
localUntitledOwner({} as LocalDocumentSessionReservationPort);
projectDocumentLiveOpener({} as LocalDocumentSessionAdoptionPort);

type PublicRegistryModule = typeof import("./document-session-registry");
// @ts-expect-error concrete implementation is not exported by the public module
export type ConcreteRegistryMustRemainPrivate = PublicRegistryModule["DocumentSessionRegistry"];
