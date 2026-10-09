/** Real Drizzle document-link scopes for DB suites, with an explicit manifest authority. */
import type { Database } from "@meridian/database";
import { sql } from "drizzle-orm";
import {
  createDrizzleDocumentLinkScopes,
  type LinkScopeMembership,
} from "../../context/adapters/document-link-scope.js";
import { createAllowAllFileAccess, type FileAccess } from "../../file-policy/index.js";
import type { EventSink } from "../../observability/index.js";
import { createLinkScopeObserver } from "../adapters/agent-edit-observability.js";
import { UNSUPPORTED_AHEAD_REFS } from "../adapters/in-memory/static-document-link-scopes.js";
import type { BranchPeerShadowAccess } from "../contracts.js";

/**
 * A controlled membership for suites that never build a manifest: every
 * content row of the project is a member of every view, live and draft. Suites
 * that exercise draft visibility pass the real authority instead
 * (`lateBoundManifestMembership`).
 */
export function everyRowMembership(db: Database): LinkScopeMembership {
  return async ({ projectId }) => {
    const rows = await db.execute<{ id: string }>(sql`
      SELECT d.id::text AS id FROM documents d
      JOIN context_sources cs ON cs.id = d.context_source_id
      LEFT JOIN works w ON w.id = cs.work_id
      WHERE d.kind = 'content' AND COALESCE(cs.project_id, w.project_id) = ${projectId}::uuid`);
    return { members: rows.map((row) => row.id) };
  };
}

/** The collab domain's own manifest authority, bound once that domain exists (as in compose). */
export function lateBoundManifestMembership() {
  let bound: Pick<BranchPeerShadowAccess, "resolveManifestMembership"> | null = null;
  const membership: LinkScopeMembership = (input) => {
    if (!bound) throw new Error("Manifest membership used before the collab domain was bound");
    return bound.resolveManifestMembership(
      input as Parameters<BranchPeerShadowAccess["resolveManifestMembership"]>[0],
    );
  };
  return {
    membership,
    bind(authority: Pick<BranchPeerShadowAccess, "resolveManifestMembership">) {
      bound = authority;
    },
  };
}

export function createTestDocumentLinkScopes(
  db: Database,
  options: {
    fileAccess?: Pick<FileAccess, "listAccess">;
    /** Default: `everyRowMembership`. */
    membership?: LinkScopeMembership;
    /** Hears the warnings a prepared scope's misses emit (they never throw). */
    eventSink?: EventSink;
  } = {},
) {
  return createDrizzleDocumentLinkScopes({
    db,
    fileAccess: options.fileAccess ?? createAllowAllFileAccess(),
    membership: options.membership ?? everyRowMembership(db),
    observer: createLinkScopeObserver(options.eventSink),
  });
}

/** The collab deps a DB suite passes for links: real scopes, no ahead-ref minting. */
export function testLinkDeps(db: Database) {
  return { links: createTestDocumentLinkScopes(db), aheadRefs: UNSUPPORTED_AHEAD_REFS };
}
