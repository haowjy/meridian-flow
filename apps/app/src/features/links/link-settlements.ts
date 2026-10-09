/**
 * What an account has learned its projects' ahead refs settled on. Owned by
 * the account lifetime (`AccountFeatureLifetime.linkSettlements`) and provided
 * to every link follower under it, so a fact one surface learned answers in
 * every other one, across catalog generations, until the account closes.
 */

import { createContext, useContext } from "react";

/**
 * What one project's ahead refs are known to have settled on. A settlement
 * never unsets, so an entry is never removed: a document id once learned is
 * final, and "settled, identity unknown" (the server answered settled gone,
 * which may only mean unreachable in that scope) waits to learn its id.
 */
export type ProjectLinkSettlements = {
  /** The settled document id; null when settled on an unknown one; undefined when not known settled. */
  get(aheadId: string): string | null | undefined;
  /** A settled server answer: its document id, or null for settled gone. */
  learn(aheadId: string, documentId: string | null): void;
};

/** Every project's settlements, owned by the account lifetime. */
export type LinkSettlements = { forProject(projectId: string): ProjectLinkSettlements };

export function createLinkSettlements(): LinkSettlements {
  const byProject = new Map<string, ProjectLinkSettlements>();
  return {
    forProject(projectId) {
      let settlements = byProject.get(projectId);
      if (!settlements) {
        const known = new Map<string, string | null>();
        settlements = {
          get: (aheadId) => known.get(aheadId),
          learn(aheadId, documentId) {
            // An id is never replaced; an unknown identity may still learn one.
            if (typeof known.get(aheadId) === "string") return;
            if (documentId !== null || !known.has(aheadId)) known.set(aheadId, documentId);
          },
        };
        byProject.set(projectId, settlements);
      }
      return settlements;
    },
  };
}

const LinkSettlementsContext = createContext<LinkSettlements | null>(null);

export const LinkSettlementsProvider = LinkSettlementsContext.Provider;

/** The account's settlements; null outside the authenticated shell (tests, SSR). */
export function useOptionalLinkSettlements(): LinkSettlements | null {
  return useContext(LinkSettlementsContext);
}
