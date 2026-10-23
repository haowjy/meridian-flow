// Accepted-save reporting that derives the revision from the frozen committed cut.
import type * as Y from "yjs";
import type { DocumentLinksPort } from "../ports/document-links.js";
import type { CommandLinks } from "./command-links.js";

export interface CommitDetectionInput {
  links: CommandLinks;
}

export interface AcceptedMutationReport {
  revision: string | null;
  /** Revision reporting failed after persistence; the save itself still landed. */
  awarenessDegraded?: true;
}

export interface CommitDetection {
  reportAcceptedMutation(
    before: Y.Doc,
    after: Y.Doc,
    input: CommitDetectionInput,
  ): Promise<AcceptedMutationReport>;
}

export function createCommitDetection(deps: { links: DocumentLinksPort }): CommitDetection {
  return {
    async reportAcceptedMutation(_before, after, input) {
      try {
        return { revision: deps.links.revision(after, input.links.scope) };
      } catch {
        return { revision: null, awarenessDegraded: true };
      }
    },
  };
}
