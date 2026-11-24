/** Real tree-backed document-link scopes for DB suites. */
import type { Database } from "@meridian/database";
import { createDrizzleDocumentLinkScopes } from "../../context/adapters/document-link-scope.js";
import { createDrizzleLinkAheadRegistry } from "../../context/adapters/drizzle-link-ahead-registry.js";
import { createAllowAllFileAccess, type FileAccess } from "../../file-policy/index.js";
import { createDrizzleNoticePort } from "../../notices/index.js";
import type { EventSink } from "../../observability/index.js";
import { createLinkScopeObserver } from "../adapters/agent-edit-observability.js";
import { UNSUPPORTED_THREAD_CONTEXT_REVERSAL_COMMAND_DEPS } from "../adapters/declared-stubs.js";
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

/**
 * The collab deps a DB suite passes beside its own: real link scopes and notices, no ahead-ref
 * minting, and no card reversal by thread (the suites that press it compose their own). A short
 * room debounce keeps the pending save, which the harness drains between cases, from taking
 * seconds.
 */
export function testCollabDeps(db: Database) {
  return {
    links: createTestDocumentLinkScopes(db),
    aheadRefs: UNSUPPORTED_AHEAD_REFS,
    roomBounds: { debounceMs: 20, maxDebounceMs: 100 },
    notices: createDrizzleNoticePort(db),
    threadContext: UNSUPPORTED_THREAD_CONTEXT_REVERSAL_COMMAND_DEPS.threadContext,
  };
}
