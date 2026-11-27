import { createContext, useContext } from "react";

export type ProjectLinkSettlements = {
  get(aheadId: string): string | null | undefined;
  learn(aheadId: string, documentId: string | null): void;
};

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

export function useOptionalLinkSettlements(): LinkSettlements | null {
  return useContext(LinkSettlementsContext);
}
