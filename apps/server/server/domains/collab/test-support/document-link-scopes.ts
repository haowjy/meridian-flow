import type { Database } from "@meridian/database";
import { createDrizzleDocumentLinkScopes } from "../../context/adapters/document-link-scope.js";
import { createDrizzleLinkAheadRegistry } from "../../context/adapters/drizzle-link-ahead-registry.js";
import { createAllowAllFileAccess, type FileAccess } from "../../file-policy/index.js";
import type { EventSink } from "../../observability/index.js";
import { createLinkScopeObserver } from "../adapters/agent-edit-observability.js";
import { UNSUPPORTED_AHEAD_REFS } from "../adapters/in-memory/static-document-link-scopes.js";

export function createTestDocumentLinkScopes(
  db: Database,
  options: {
    fileAccess?: Pick<FileAccess, "listAccess">;
    eventSink?: EventSink;
  } = {},
) {
  return createDrizzleDocumentLinkScopes({
    db,
    fileAccess: options.fileAccess ?? createAllowAllFileAccess(),
    observer: createLinkScopeObserver(options.eventSink),
  });
}

export function createTestLinkAheadRegistry(db: Database, eventSink?: EventSink) {
  return createDrizzleLinkAheadRegistry(db, eventSink ? { eventSink } : {});
}

export function testLinkDeps(db: Database) {
  return {
    links: createTestDocumentLinkScopes(db),
    aheadRefs: UNSUPPORTED_AHEAD_REFS,
    roomBounds: { debounceMs: 20, maxDebounceMs: 100 },
  };
}
