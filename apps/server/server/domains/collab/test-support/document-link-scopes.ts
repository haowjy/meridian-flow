/** Real Drizzle document-link scopes for DB suites, with test-friendly defaults. */
import type { Database } from "@meridian/database";
import {
  createDrizzleDocumentLinkScopes,
  type LinkScopeMembership,
} from "../../context/adapters/document-link-scope.js";
import { createAllowAllFileAccess, type FileAccess } from "../../file-policy/index.js";
import { createLinkScopeObserver } from "../adapters/agent-edit-observability.js";
import { UNSUPPORTED_AHEAD_REFS } from "../adapters/in-memory/static-document-link-scopes.js";

export function createTestDocumentLinkScopes(
  db: Database,
  options: {
    fileAccess?: Pick<FileAccess, "listAccess">;
    /** Default: no manifest authority, every non-deleted row is live. */
    membership?: LinkScopeMembership;
  } = {},
) {
  return createDrizzleDocumentLinkScopes({
    db,
    fileAccess: options.fileAccess ?? createAllowAllFileAccess(),
    ...(options.membership ? { membership: options.membership } : {}),
    observer: createLinkScopeObserver(),
  });
}

/** The collab deps a DB suite passes for links: real scopes, no ahead-ref minting. */
export function testLinkDeps(db: Database) {
  return { links: createTestDocumentLinkScopes(db), aheadRefs: UNSUPPORTED_AHEAD_REFS };
}
