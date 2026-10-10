/** Real tree-backed document-link scopes for DB suites. */
import type { Database } from "@meridian/database";
import { createDrizzleDocumentLinkScopes } from "../../context/adapters/document-link-scope.js";
import { createAllowAllFileAccess, type FileAccess } from "../../file-policy/index.js";
import type { EventSink } from "../../observability/index.js";
import { createLinkScopeObserver } from "../adapters/agent-edit-observability.js";
import {
  createDrizzleDraftStore,
  createDrizzleDraftWriteBoundary,
} from "../adapters/drizzle-drafts.js";
import { UNSUPPORTED_AHEAD_REFS } from "../adapters/in-memory/static-document-link-scopes.js";
import { createDrafts } from "../domain/drafts.js";

export function createTestDocumentLinkScopes(
  db: Database,
  options: {
    fileAccess?: Pick<FileAccess, "listAccess">;
    drafts?: Pick<import("../domain/drafts.js").Drafts, "viewForWork">;
    /** Hears the warnings a prepared scope's misses emit (they never throw). */
    eventSink?: EventSink;
  } = {},
) {
  return createDrizzleDocumentLinkScopes({
    db,
    fileAccess: options.fileAccess ?? createAllowAllFileAccess(),
    drafts:
      options.drafts ??
      createDrafts({
        store: createDrizzleDraftStore(db),
        boundary: createDrizzleDraftWriteBoundary(db),
      }),
    observer: createLinkScopeObserver(options.eventSink),
  });
}

/** The collab deps a DB suite passes for links: real scopes, no ahead-ref minting. */
export function testLinkDeps(db: Database) {
  return { links: createTestDocumentLinkScopes(db), aheadRefs: UNSUPPORTED_AHEAD_REFS };
}
