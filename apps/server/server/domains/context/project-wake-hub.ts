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
  /** Wakes every project this user has open, with the hint each of those projects gets. */
  publishToUser(userId: string, hintFor: (projectId: string) => ProjectHint): void;
};

export function createProjectWakeHub(): ProjectWakeHub {
  const subscribers = new Set<Subscriber>();
  const send = (subscriber: Subscriber, hint: ProjectHint) => {
    try {
      subscriber.listener(hint);
    } catch {
      // Hints contain no truth and are repaired by focus/poll acquisition.
    }
  };
  return {
    publish(hint) {
      for (const subscriber of subscribers) {
        if (hint.projectId === subscriber.projectId) send(subscriber, hint);
      }
    },
    publishToUser(userId, hintFor) {
      for (const subscriber of subscribers) {
        if (subscriber.userId === userId) send(subscriber, hintFor(subscriber.projectId));
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
    publishDraftHints: publishLossy,
    publishSourcesHint: (projectId) => publishLossy([{ type: "context-sources-hint", projectId }]),
  };
}
