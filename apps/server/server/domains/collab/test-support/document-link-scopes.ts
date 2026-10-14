/** Real tree-backed document-link scopes for DB suites. */
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
    /** Hears the warnings a prepared scope's misses emit (they never throw). */
    eventSink?: EventSink;
  } = {},
) {
  return createDrizzleDocumentLinkScopes({
    db,
    fileAccess: options.fileAccess ?? createAllowAllFileAccess(),
    observer: createLinkScopeObserver(options.eventSink),
  });
}

/** The production ahead-ref registry over a DB suite's database,. */
export function createTestLinkAheadRegistry(db: Database, eventSink?: EventSink) {
  return createDrizzleLinkAheadRegistry(db, eventSink ? { eventSink } : {});
}

/** The collab deps a DB suite passes for links: real scopes, no ahead-ref minting. */
export function testLinkDeps(db: Database) {
  return { links: createTestDocumentLinkScopes(db), aheadRefs: UNSUPPORTED_AHEAD_REFS };
}
