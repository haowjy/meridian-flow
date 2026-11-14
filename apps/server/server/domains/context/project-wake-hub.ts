/** Lossy live fan-out of a project's hints over authenticated transports. */

import { runAfterDrizzleCommit } from "../../shared/drizzle-transaction.js";
import type { ProjectHint, ProjectHintPort, ProjectWakePort } from "./ports/project-hints.js";

type Subscriber = {
  projectId: string;
  userId: string;
  listener: (hint: ProjectHint) => void;
};

export type ProjectWakeHub = ProjectWakePort & {
  subscribe(input: Subscriber): () => void;
};

export function createProjectWakeHub(): ProjectWakeHub {
  const subscribers = new Set<Subscriber>();
  return {
    publish(hint) {
      for (const subscriber of subscribers) {
        if (hint.projectId !== subscriber.projectId) continue;
        try {
          subscriber.listener(hint);
        } catch {
          // Hints contain no truth and are repaired by focus/poll acquisition.
        }
      }
    },
    subscribe(input) {
      subscribers.add(input);
      return () => subscribers.delete(input);
    },
  };
}

/** Hints go out after the writer's transaction commits; a lost one leaves a list stale until its next read. */
export function createProjectHints(wake: ProjectWakePort): ProjectHintPort {
  function publishLossy(hints: readonly ProjectHint[]) {
    if (hints.length === 0) return;
    runAfterDrizzleCommit(async () => {
      for (const hint of hints) {
        try {
          await wake.publish(hint);
        } catch {
          // Lossy by design.
        }
      }
    });
  }
  return {
    publishDraftOwnerHints: publishLossy,
    publishSourcesHint: (projectId) => publishLossy([{ type: "context-sources-hint", projectId }]),
  };
}
